/**
 * predexec core — plan-tree & condition-DSL data model.
 *
 * PURE TS. This module (and everything under core/) imports NOTHING from any
 * harness (pi/opencode/MCP). It is promotable to a standalone package as-is.
 *
 * The model pre-compiles its branch decisions into this tree; the engine walks
 * it deterministically with no model call between levels (see engine.ts).
 */

export type NodeId = string;

/** A tool call operation within a node batch. The `tool` key names the tool; remaining keys are tool-specific args. */
export interface ToolOp {
  tool: string;
  [key: string]: unknown;
}

/** A single step in a node's batch: a shell command (string) or a tool call (object). */
export type Operation = string | ToolOp;
/** A host-policy verdict: the matched rule/pattern when the host would deny or prompt, null to run. */
export type PolicyVerdict = string | null;
/** What the engine tells a policy checker about the walk it is checking for. */
export interface PolicyCheckContext {
  /** The node's effective working directory (plan `cwd` resolved against the session root). */
  cwd: string;
  /** The session root (`RunOptions.cwd`). */
  sessionRoot: string;
  /** The run's abort signal; the engine also races a pending check against it. */
  signal?: AbortSignal;
}
/**
 * Adapter-provided host-policy check for every operation in a node batch. It
 * may answer asynchronously (a host permission bridge); the engine awaits it.
 */
export type OperationPolicyChecker = (
  operation: Operation,
  context: PolicyCheckContext,
) => PolicyVerdict | Promise<PolicyVerdict>;

export interface PlanNode {
  id: NodeId;
  /** The batch run at this node. Strings are shell commands; objects are tool calls. Sequential by default; concurrent if `parallel`. */
  commands: Operation[];
  /** Run `commands` concurrently instead of sequentially. Default false. */
  parallel?: boolean;
  /**
   * Model-declared write/install/delete. A mutating node is a HARD STOP: the
   * engine returns BEFORE running it (read-only MVP), handing control back to
   * the normal agent loop. Speculation stays in the recoverable read-only zone.
   */
  mutates?: boolean;
  /** Evaluated in order, first match wins. None => leaf (the path ends here). */
  edges?: PlanEdge[];
}

export interface PlanEdge {
  when: Condition;
  to: NodeId;
}

/**
 * Confidence-tiered condition DSL. All predicates are machine-evaluable with no
 * model in the loop.
 *
 * HIGH-confidence (cleanly separable) predicates may gate deeper speculation,
 * including — once mutation support lands — a permitted mutating child.
 * LOW-confidence (fuzzy NL `match`) edges may branch ONLY to a read-only node;
 * that is where a coarse predicate's false-hits turn malignant. The boundary is
 * enforced in engine.ts via HIGH_CONFIDENCE_KINDS.
 */
export type Condition =
  // --- high-confidence (cleanly separable) ---
  | { kind: "exitCode"; op: "eq" | "ne" | "lt" | "gt"; value: number }
  | { kind: "fileExists"; path: string; negate?: boolean }
  | { kind: "jsonPath"; source: "stdout"; path: string; op: "eq" | "ne" | "exists"; value?: unknown }
  | { kind: "numeric"; source: "stdout"; extract: string; op: "lt" | "le" | "gt" | "ge" | "eq"; value: number }
  // --- low-confidence (fuzzy) — read-only children only ---
  | { kind: "match"; source: "stdout" | "stderr"; regex: string; negate?: boolean }
  | { kind: "always" };

export type ConditionKind = Condition["kind"];

/** Every condition kind, in documentation order. Single source for kind lists. */
export const CONDITION_KINDS = Object.freeze([
  "exitCode",
  "fileExists",
  "jsonPath",
  "numeric",
  "match",
  "always",
] as const);

// Compile-time proof that CONDITION_KINDS and the Condition union agree.
type ExactKinds<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const conditionKindsMatchUnion: ExactKinds<(typeof CONDITION_KINDS)[number], ConditionKind> = true;
void conditionKindsMatchUnion;

/** The only low-confidence kind: fuzzy regex matching over output. */
const LOW_CONFIDENCE_KINDS: ReadonlySet<ConditionKind> = new Set<ConditionKind>(["match"]);

/** Single source of truth for the tier boundary (see Condition doc above). */
export const HIGH_CONFIDENCE_KINDS: ReadonlySet<ConditionKind> = new Set<ConditionKind>(
  CONDITION_KINDS.filter((kind) => !LOW_CONFIDENCE_KINDS.has(kind)),
);

/** Native read-only tool operations a plan node may call. */
export const TOOL_NAMES = Object.freeze(["read", "grep", "find", "ls"] as const);

/** Why a jsonPath edge needs a single-operation source node (engine error and schema prose). */
export const JSON_PATH_SINGLE_OP_MESSAGE = "jsonPath edges require a one-operation source node.";

export interface PlanTree {
  root: NodeId;
  nodes: PlanNode[];
  /**
   * Base working directory for ALL commands and `fileExists` checks. Must be a
   * non-empty relative directory inside the session cwd; the engine validates
   * this at runtime before any command runs. Set this once instead of prefixing
   * every command with `cd`.
   */
  cwd?: string;
  /** Backstop cap on speculation depth. The model self-limits; this is the user/engine ceiling. */
  maxDepth?: number;
}

/** Aggregated result of running one node's command batch. Internal to the core. */
export interface NodeOutput {
  stdout: string;
  stderr: string;
  /** The failing command's exit code (stop-on-first-error) or the last command's. */
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type StoppedReason =
  | "leaf"
  | "noEdgeMatch"
  | "maxDepth"
  | "mutationStop"
  | "policyStop"
  | "error"
  | "aborted";

export interface CoreResult {
  /** Model-readable log of the walked path (per-node command, exit code, truncated output). */
  transcript: string;
  pathTaken: NodeId[];
  depthReached: number;
  stoppedReason: StoppedReason;
  /** True unless we ended on a success leaf — i.e. the agent loop should resume. */
  fellBack: boolean;
  /** A success leaf that may end the turn (pi `terminate`). Not acted on in the read-only MVP. */
  terminal: boolean;
  // ── instrumentation (recorded per run by stats.ts; false-hit attribution not yet built) ──
  edgesEvaluated: number;
  edgesMatched: number;
}

export interface ProgressEvent {
  nodeId: string;
  transcript: string;
  pathTaken: NodeId[];
  depthReached: number;
}

export type OnProgress = (event: ProgressEvent) => void;
export type OnCommandOutput = (data: string) => void;

/** Adapter-provided callback to execute tool operations. Returns normalized shell-like output. */
export type ToolExecutor = (
  op: ToolOp,
  opts: { cwd: string; signal?: AbortSignal },
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the adapter intentionally omitted part of stdout. */
  stdoutTruncated?: boolean;
  /** True when the adapter intentionally omitted part of stderr. */
  stderrTruncated?: boolean;
}>;

export interface RunOptions {
  cwd: string;
  signal?: AbortSignal;
  onProgress?: OnProgress;
  onCommandOutput?: OnCommandOutput;
  /** Callback to execute tool operations ({tool, ...args}). Required when plan contains tool ops. */
  executeToolOp?: ToolExecutor;
  /**
   * Adapter-provided host-policy check for every operation. Returns the matched
   * rule/pattern when the HOST would deny or prompt for the command (predexec
   * cannot prompt mid-walk → policyStop hard-stop before running), null to run.
   * Shell commands are also checked per inner clause of a `sh|bash|zsh|dash -c`
   * script and with an absolute-path head reduced to its basename. A checker
   * that throws or rejects is a policyStop (fail closed).
   */
  checkOperationPolicy?: OperationPolicyChecker;
  /**
   * Wall-clock bound for each shell command, clamped to
   * [1_000, MAX_COMMAND_TIMEOUT_MS]; defaults to DEFAULT_COMMAND_TIMEOUT_MS.
   * A timed-out command's process group is SIGKILLed and it reports exitCode 124.
   */
  commandTimeoutMs?: number;
}

/** Default per-shell-command wall-clock bound (ms). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** Upper clamp for RunOptions.commandTimeoutMs (ms). */
export const MAX_COMMAND_TIMEOUT_MS = 600_000;

/** Engine-level backstop when a plan omits maxDepth. */
export const DEFAULT_MAX_DEPTH = 8;

/** Maximum number of operations a single node may schedule. */
export const MAX_OPERATIONS_PER_NODE = 64;

/** Maximum number of operations running concurrently within a parallel node. */
export const MAX_PARALLEL_CONCURRENCY = 8;

/** Maximum nodes accepted from one model-authored plan. */
export const MAX_PLAN_NODES = 256;
/** Maximum outgoing edges across one model-authored plan. */
export const MAX_PLAN_EDGES = 1024;
/** Maximum length of any shell command or tool string argument. */
export const MAX_COMMAND_LENGTH = 64 * 1024;
/**
 * Longest whitespace-free run the destructive-command classifier will scan.
 * Longer input is classified mutating ("oversized shell word") without
 * scanning: a backstop that keeps the evaluator total even if some lexer path
 * turns out super-linear on one long word.
 */
export const MAX_CLASSIFY_WORD_LENGTH = 32 * 1024;
/** Maximum length of a node/edge identifier. */
export const MAX_NODE_ID_LENGTH = 256;
/** Maximum length of one model-authored condition string or payload. */
export const MAX_CONDITION_LENGTH = 8 * 1024;
/** Maximum aggregate length of condition payloads and edge targets in one plan. */
export const MAX_CONDITION_TOTAL_LENGTH = 256 * 1024;
/** Maximum nesting depth of a direct jsonPath comparison value (root is depth 0). */
export const MAX_JSON_VALUE_DEPTH = 32;
/** Maximum scalar/container nodes in a direct jsonPath comparison value. */
export const MAX_JSON_VALUE_NODES = 4096;
/** Maximum length of one string in a direct jsonPath comparison value. */
export const MAX_JSON_VALUE_STRING_LENGTH = MAX_CONDITION_LENGTH;
/** Maximum lines a native read operation may request. */
export const MAX_READ_LINES = 10_000;
/** Shared maximum result count for native grep and find operations. */
export const MAX_SEARCH_RESULTS = 1_000;
export const MAX_GREP_RESULTS = MAX_SEARCH_RESULTS;
export const MAX_FIND_RESULTS = MAX_SEARCH_RESULTS;
/** Maximum length of a native grep pattern across all adapters. */
export const MAX_GREP_PATTERN_LENGTH = 8 * 1024;
/** Maximum directory entries a native ls operation may retain. */
export const MAX_LS_ENTRIES = 5_000;
/** Maximum context lines on either side of a native grep match. */
export const MAX_GREP_CONTEXT = 100;
