/**
 * predexec — pi coding agent adapter (read-only MVP).
 *
 * Registers ONE tool, `predexec`, that runs a pre-planned tree of command
 * batches with deterministic branch conditions in a single model round-trip.
 * All real logic lives in ../../core, entered through ../../adapter-runtime.ts;
 * this file builds the JSON Schema, wires ctx.cwd + signal + onUpdate, and maps
 * native tool ops (read/grep/find/ls) to pi's tool factories.
 *
 * The pi API type is import-type-only, but the tool factories
 * (createReadTool/etc.) are runtime imports from the host package.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@earendil-works/pi-coding-agent";
import { coercePlan, isDestructiveCommand, OUTPUT_CAP, validateOperation, type ToolOp } from "../../core/index.ts";
import { TRUNCATION_MARKER } from "../../core/runner.ts";
import type { ProgressEvent } from "../../core/types.ts";
import { executeAdapterPlan, userClassifierOptions } from "../../adapter-runtime.ts";
import { BASH_NUDGE, JSON_PATH_SINGLE_OP_LINE, VERIFY_FIRST_LINE } from "../../steering.ts";
import {
  CONDITION_KINDS,
  DEFAULT_MAX_DEPTH,
  MAX_OPERATIONS_PER_NODE,
  MAX_PARALLEL_CONCURRENCY,
  PLAN_CWD_DESCRIPTION,
  PLAN_FIELD_NAMES,
  RESOURCE_LIMIT_DESCRIPTION,
  TOOL_OPERATION_NAMES,
} from "../../plan-language.ts";

/**
 * Condition is modelled as a single loose object (discriminated by `kind`)
 * rather than a strict union: anyOf/oneOf and literal-union schemas are rejected
 * or mangled by some providers (notably Google). The core evaluator is
 * exception-safe and switches on `kind`, so a superset object is robust. Field
 * descriptions teach which fields pair with which kind.
 */
const Condition = {
  type: "object",
  description: "Deterministic edge condition.",
  properties: {
    kind: {
      type: "string",
      enum: [...CONDITION_KINDS],
      description: "exitCode/fileExists/jsonPath/numeric = high-confidence; match = low-confidence (read-only children only); always = unconditional.",
    },
    op: {
      type: "string",
      enum: ["eq", "ne", "lt", "gt", "le", "ge", "exists"],
      description: "exitCode: eq/ne/lt/gt. numeric: lt/le/gt/ge/eq. jsonPath: eq/ne/exists.",
    },
    value: { description: "Comparison value (exitCode/numeric/jsonPath)." },
    path: {
      type: "string",
      description: "fileExists: path relative to cwd. jsonPath: dot/bracket path in stdout JSON.",
    },
    source: {
      type: "string",
      enum: ["stdout", "stderr"],
      description: "Stream to test (match/numeric/jsonPath).",
    },
    extract: {
      type: "string",
      description: "numeric: regex to extract number (group 1 or whole match).",
    },
    regex: { type: "string", description: "match: regex to test." },
    negate: { type: "boolean", description: "Invert result (fileExists/match)." },
  },
  required: ["kind"],
} as const;

const PlanEdge = {
  type: "object",
  properties: {
    [PLAN_FIELD_NAMES.when]: {
      description:
        'Condition as object OR shorthand string. ' +
        'Strings: "exit == 0", "exit != 0", "exit > N", "exit < N", ' +
        '"stdout =~ /regex/", "stderr =~ /regex/", "stdout !~ /regex/", ' +
        '"file exists path", "file missing path", "always". ' +
        `Object form (for ${CONDITION_KINDS.join("/")}): see Condition schema. ` + JSON_PATH_SINGLE_OP_LINE,
    },
    [PLAN_FIELD_NAMES.to]: { type: "string", description: "Target node id." },
  },
  required: [PLAN_FIELD_NAMES.when, PLAN_FIELD_NAMES.to],
} as const;

const PlanNode = {
  type: "object",
  properties: {
    [PLAN_FIELD_NAMES.id]: { type: "string", description: "Unique node id." },
    [PLAN_FIELD_NAMES.commands]: {
      type: "array",
      maxItems: MAX_OPERATIONS_PER_NODE,
      items: {
        description:
          "Shell command (string) or tool call (object with 'tool' key). " +
          `Read-only tools: ${TOOL_OPERATION_NAMES[0]} ({tool,path,offset?,limit?}), ${TOOL_OPERATION_NAMES[1]} ({tool,pattern,path?,glob?,ignoreCase?,literal?,context?,limit?}), ` +
          `${TOOL_OPERATION_NAMES[2]} ({tool,pattern,path?,limit?}), ${TOOL_OPERATION_NAMES[3]} ({tool,path?,limit?}). ` +
          RESOURCE_LIMIT_DESCRIPTION + " " +
          "Mutating tools (hard-stop): edit, write.",
      },
      description: "Shell commands and/or tool calls. Sequential (stop-on-first-error) unless parallel:true.",
    },
    [PLAN_FIELD_NAMES.parallel]: {
      type: "boolean",
      description: `Run commands concurrently instead of sequentially (capped at ${MAX_PARALLEL_CONCURRENCY}).`,
    },
    [PLAN_FIELD_NAMES.mutates]: {
      type: "boolean",
      description:
        "True ONLY for writes/installs/deletes. Tests/builds/linters/cat/ls/grep are NOT mutating. Mutating nodes hard-stop without running.",
    },
    [PLAN_FIELD_NAMES.edges]: {
      type: "array",
      items: PlanEdge,
      description: "Conditions evaluated in order; first match wins. Omit for a leaf.",
    },
  },
  required: [PLAN_FIELD_NAMES.id, PLAN_FIELD_NAMES.commands],
} as const;

const PlanTreeSchema = {
  type: "object",
  properties: {
    [PLAN_FIELD_NAMES.root]: { type: "string", description: "Starting node id." },
    [PLAN_FIELD_NAMES.nodes]: { type: "array", items: PlanNode },
    [PLAN_FIELD_NAMES.cwd]: {
      type: "string",
      description: PLAN_CWD_DESCRIPTION,
    },
    [PLAN_FIELD_NAMES.maxDepth]: {
      type: "number",
      maximum: DEFAULT_MAX_DEPTH,
      description: `Cap on speculation depth; maximum ${DEFAULT_MAX_DEPTH}. Values above ${DEFAULT_MAX_DEPTH} are rejected by this schema.`,
    },
  },
  required: [PLAN_FIELD_NAMES.root, PLAN_FIELD_NAMES.nodes],
};

const DESCRIPTION =
  "Run read-only shell commands and tool calls with deterministic branching. " +
  "Each node runs shell commands (strings) and/or tool calls ({tool, ...args}) sequentially or concurrently. " +
  "Edges evaluate conditions on output to choose the next node with no model call between levels. " +
  VERIFY_FIRST_LINE;

type TextContent = { type: "text"; text: string };

/** Append streamed progress without retaining unbounded command output. */
export function appendProgressText(current: string, data: string): string {
  const combined = current + data;
  if (combined.length <= OUTPUT_CAP) return combined;
  return `${combined.slice(0, OUTPUT_CAP)}\n${TRUNCATION_MARKER}]`;
}

/**
 * Map a pi tool result to shell-like output — exported for unit tests.
 *
 * Exit-code PARITY with the opencode adapter: grep/find with zero results
 * return exit 1, everything else that succeeded returns 0, so an `exit == 0`
 * edge branches identically on both harnesses. pi tools don't expose a count;
 * zero results are detected via the sentinel text pi emits with NO details
 * (dist/core/tools/grep.js / find.js in @earendil-works/pi-coding-agent — the
 * sentinels are unchanged as of 0.82.1; revisit if they change upstream).
 */
export function mapToolResult(
  tool: string,
  stdout: string,
  details: unknown,
): { stdout: string; stderr: string; exitCode: number; stdoutTruncated?: boolean } {
  const noResults =
    details === undefined &&
    ((tool === "grep" && stdout.trim() === "No matches found") ||
      (tool === "find" && stdout.trim().startsWith("No files found matching pattern")));
  const detailKeys = details && typeof details === "object" ? Object.keys(details) : [];
  const stdoutTruncated = detailKeys.some((key) =>
    key === "truncation" || key === "matchLimitReached" || key === "entryLimitReached" ||
    key === "resultLimitReached" || key === "linesTruncated",
  );
  return { stdout, stderr: "", exitCode: noResults ? 1 : 0, ...(stdoutTruncated ? { stdoutTruncated: true } : {}) };
}

type PiTool = { execute: (id: string, params: any, signal?: AbortSignal) => Promise<{ content: { type: string; text?: string }[]; details?: unknown }> };

function createToolExecutor(cwd: string, signal?: AbortSignal) {
  const toolMaps = new Map<string, Record<string, PiTool>>();

  const toolsFor = (effectiveCwd: string): Record<string, PiTool> => {
    const existing = toolMaps.get(effectiveCwd);
    if (existing) return existing;
    const tools = {
      read: createReadTool(effectiveCwd),
      grep: createGrepTool(effectiveCwd),
      find: createFindTool(effectiveCwd),
      ls: createLsTool(effectiveCwd),
    };
    toolMaps.set(effectiveCwd, tools);
    return tools;
  };

  // "Never ran" (invalid arg, unknown tool, an underlying tool.execute() throw
  // — e.g. ENOEXEC from a broken ~/.pi/agent/bin/rg) is exit 2, matching the
  // MCP and opencode adapters; a search that ran and found nothing stays exit
  // 1 (see mapToolResult). Exit 1 previously covered BOTH cases here, so a
  // broken tool binary was indistinguishable from "no matches" (PI-2).
  const NEVER_RAN = 2;

  return async (op: ToolOp, opts: { cwd: string; signal?: AbortSignal }) => {
    const validationError = validateOperation(op);
    if (validationError) return { stdout: "", stderr: `invalid operation: ${validationError}`, exitCode: NEVER_RAN };
    const tools = toolsFor(opts.cwd ?? cwd);
    const tool = tools[op.tool];
    if (!tool) {
      return { stdout: "", stderr: `unknown tool: ${op.tool}`, exitCode: NEVER_RAN };
    }
    try {
      const { tool: _name, ...args } = op;
      const result = await tool.execute(`predexec-${Date.now()}`, args, opts.signal ?? signal);
      const stdout = result.content
        .filter((c): c is TextContent => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
      return mapToolResult(op.tool, stdout, result.details);
    } catch (err) {
      return { stdout: "", stderr: (err as Error).message, exitCode: NEVER_RAN };
    }
  };
}

/**
 * pi validates a tool call's arguments against `parameters` (a JSON Schema)
 * BEFORE `execute` ever runs — unlike the MCP and opencode adapters, where our
 * own `coercePlan` (inside `executeAdapterPlan`) is the first thing that sees
 * the raw model output. Without this hook, a model that emits a
 * double-encoded `nodes` string, a whole stringified plan, or the
 * single-command shorthand `commands:"ls"` (a bare string where the schema
 * requires an array) gets rejected by pi's own schema check and `execute`
 * never runs at all — `coercePlan`'s recovery never gets a chance (PI-1).
 *
 * Reuses the shared `coercePlan` (still re-run, harmlessly, inside
 * `executeAdapterPlan`) for the JSON-string recovery instead of reimplementing
 * it; the one thing it does NOT cover is `commands` arriving as a bare
 * string per node — pi's schema requires an array, but coercePlan's job is
 * JSON-string recovery, not shape coercion — so that's normalized here too.
 *
 * Must never throw: pi treats a `prepareArguments` throw as an immediate
 * tool-call error that skips `execute` entirely, forfeiting the friendlier,
 * engine-produced diagnostic a genuinely malformed plan gets when it reaches
 * `executeAdapterPlan`'s own `coercePlan` call instead. On failure the raw
 * args pass through unchanged so pi's schema validation (or `execute`, if
 * that validation still accepts them) reports the problem.
 */
export function prepareArguments(args: unknown): Record<string, unknown> {
  let plan: unknown;
  try {
    plan = coercePlan(args);
  } catch {
    return (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  }
  const nodes = (plan as { nodes?: unknown }).nodes;
  if (Array.isArray(nodes)) {
    (plan as { nodes: unknown[] }).nodes = nodes.map((node) =>
      node && typeof node === "object" && typeof (node as { commands?: unknown }).commands === "string"
        ? { ...node, commands: [(node as { commands: string }).commands] }
        : node,
    );
  }
  return plan as Record<string, unknown>;
}

export default function predexec(pi: ExtensionAPI): void {
  // Routing steering is delivered declaratively via the `predexec` skill
  // (.pi/skills/predexec/SKILL.md, generated from steering.ts and registered through
  // package.json `pi.skills`) plus the tool's promptSnippet below, which pi needs to
  // list the tool — pi surfaces both natively.
  // No imperative system-prompt mutation here (that coupled to pi's internal
  // wording and broke silently when it changed).

  pi.on("tool_result", async (event) => {
    // A failed shell result is not "read-only work worth batching" — nudging
    // toward MORE predexec calls after an error reads as predexec papering
    // over the failure (PI-4). `powershell` is a separate tool from `bash`
    // (added post-0.82.1) that runs the same read-only-vs-mutating shell
    // commands and deserves the identical nudge.
    if (event.isError) return;
    if (event.toolName === "bash" || event.toolName === "powershell") {
      const cmd = (event as { input?: { command?: string } }).input?.command ?? "";
      if (!cmd || isDestructiveCommand(cmd, userClassifierOptions())) return;
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `\n\n${BASH_NUDGE}` },
        ],
      };
    }
  });

  pi.registerTool({
    name: "predexec",
    label: "predexec",
    description: DESCRIPTION,
    promptSnippet: "Default tool for read-only work — shell commands, tool calls (read/grep/find/ls), and branching sequences",
    // A pointer only: tool-op syntax, edge conditions and stop/recovery rules
    // live in the predexec skill (rendered from steering.ts), which pi loads.
    promptGuidelines: [
      "predexec: see the predexec skill for tool-op syntax, edge conditions, and mutationStop/noEdgeMatch recovery.",
    ],
    parameters: PlanTreeSchema as any,
    prepareArguments,
    async execute(_toolCallId, params: Record<string, unknown>, signal, onUpdate, ctx) {
      let lastUpdateAt = 0;
      let pendingTimeout: ReturnType<typeof setTimeout> | undefined;
      let streamedText = "";
      const UPDATE_INTERVAL = 100;

      const emitUpdate = (text: string, details?: Record<string, unknown>) => {
        if (!onUpdate) return;
        onUpdate({
          content: [{ type: "text" as const, text: text || "(running…)" }],
          details: details ?? {},
        });
      };

      const scheduleOutputUpdate = () => {
        if (!onUpdate) return;
        const now = Date.now();
        const elapsed = now - lastUpdateAt;
        if (elapsed >= UPDATE_INTERVAL) {
          lastUpdateAt = now;
          emitUpdate(streamedText);
        } else if (!pendingTimeout) {
          pendingTimeout = setTimeout(() => {
            pendingTimeout = undefined;
            lastUpdateAt = Date.now();
            emitUpdate(streamedText);
          }, UPDATE_INTERVAL - elapsed);
        }
      };

      if (onUpdate) emitUpdate("");

      const executeToolOp = createToolExecutor(ctx.cwd, signal);

      let done = false;

      const progressHandlers = onUpdate
        ? {
            onProgress(event: ProgressEvent) {
              if (done) return;
              streamedText = appendProgressText("", event.transcript);
              emitUpdate(streamedText, {
                nodeId: event.nodeId,
                depthReached: event.depthReached,
                pathTaken: event.pathTaken,
              });
            },
            onCommandOutput(data: string) {
              if (done) return;
              streamedText = appendProgressText(streamedText, data);
              scheduleOutputUpdate();
            },
          }
        : {};

      const result = await executeAdapterPlan(params, "pi", {
        cwd: ctx.cwd,
        signal,
        executeToolOp,
        ...progressHandlers,
      });

      done = true;
      if (pendingTimeout) clearTimeout(pendingTimeout);
      // pi's own contract (docs/extensions.md: "Throw from execute() to produce
      // a failed tool result. Returning an object does not mark it as an
      // error.") — a coercion/engine failure returned as a normal object was
      // rendered as a SUCCESS by pi (PI-3), hiding it from isError-gated logic
      // (including this file's own tool_result nudge, above).
      if (result.stoppedReason === "error") {
        throw new Error(result.transcript || "predexec: the plan failed for an unknown reason.");
      }
      return {
        content: [{ type: "text" as const, text: result.transcript || "(no output)" }],
        details: {
          depthReached: result.depthReached,
          pathTaken: result.pathTaken,
          stoppedReason: result.stoppedReason,
          fellBack: result.fellBack,
          edgesEvaluated: result.edgesEvaluated,
          edgesMatched: result.edgesMatched,
        },
        // No `terminate` in the read-only MVP: a read-only leaf usually still
        // needs the model. Deferred until mutation execution lands (gated mutations + success leaves).
      };
    },
  });
}
