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

export interface PlanNode {
  id: NodeId;
  /** The batch run at this node. Sequential by default; concurrent if `parallel`. */
  commands: string[];
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

/** Single source of truth for the tier boundary (see Condition doc above). */
export const HIGH_CONFIDENCE_KINDS: ReadonlySet<ConditionKind> = new Set<ConditionKind>([
  "exitCode",
  "fileExists",
  "jsonPath",
  "numeric",
  "always",
]);

export interface PlanTree {
  root: NodeId;
  nodes: PlanNode[];
  /**
   * Base working directory for ALL commands and `fileExists` checks. Relative
   * paths resolve against the session cwd. Set this once instead of prefixing
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
}

export type StoppedReason =
  | "leaf"
  | "noEdgeMatch"
  | "maxDepth"
  | "mutationStop"
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
  // ── instrumentation (full request-accounting analysis is impl step 2) ──
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

export interface RunOptions {
  cwd: string;
  signal?: AbortSignal;
  onProgress?: OnProgress;
  onCommandOutput?: OnCommandOutput;
}

/** Engine-level backstop when a plan omits maxDepth. */
export const DEFAULT_MAX_DEPTH = 8;
