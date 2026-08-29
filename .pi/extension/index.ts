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
import { isDestructiveCommand, OUTPUT_CAP, type ToolOp } from "../../core/index.ts";
import { TRUNCATION_MARKER } from "../../core/runner.ts";
import type { ProgressEvent } from "../../core/types.ts";
import { executeAdapterPlan } from "../../adapter-runtime.ts";
import { BASH_NUDGE, JSON_PATH_SINGLE_OP_LINE, RECOVERY_LINE, USAGE_LINE, VERIFY_FIRST_LINE } from "../../steering.ts";
import {
  CONDITION_KINDS,
  DEFAULT_MAX_DEPTH,
  MAX_OPERATIONS_PER_NODE,
  MAX_PARALLEL_CONCURRENCY,
  PLAN_CWD_DESCRIPTION,
  PLAN_FIELD_NAMES,
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
          `Read-only tools: ${TOOL_OPERATION_NAMES[0]} ({tool,path,offset?,limit?}), ${TOOL_OPERATION_NAMES[1]} ({tool,pattern,path?,glob?,ignoreCase?}), ` +
          `${TOOL_OPERATION_NAMES[2]} ({tool,pattern,path?}), ${TOOL_OPERATION_NAMES[3]} ({tool,path?}). ` +
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
      description: `Cap on speculation depth; values above ${DEFAULT_MAX_DEPTH} are clamped.`,
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
): { stdout: string; stderr: string; exitCode: number } {
  const noResults =
    details === undefined &&
    ((tool === "grep" && stdout.trim() === "No matches found") ||
      (tool === "find" && stdout.trim().startsWith("No files found matching pattern")));
  return { stdout, stderr: "", exitCode: noResults ? 1 : 0 };
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

  return async (op: ToolOp, opts: { cwd: string; signal?: AbortSignal }) => {
    const tools = toolsFor(opts.cwd ?? cwd);
    const tool = tools[op.tool];
    if (!tool) {
      return { stdout: "", stderr: `unknown tool: ${op.tool}`, exitCode: 1 };
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
      return { stdout: "", stderr: (err as Error).message, exitCode: 1 };
    }
  };
}

export default function predexec(pi: ExtensionAPI): void {
  // Routing steering is delivered declaratively via the `predexec` skill
  // (.pi/skills/predexec/SKILL.md, registered through package.json `pi.skills`) plus
  // the tool's promptSnippet/promptGuidelines below — pi surfaces both natively.
  // No imperative system-prompt mutation here (that coupled to pi's internal
  // wording and broke silently when it changed).

  pi.on("tool_result", async (event) => {
    if (event.toolName === "bash") {
      const cmd = (event as { input?: { command?: string } }).input?.command ?? "";
      if (!cmd || isDestructiveCommand(cmd)) return;
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
    promptGuidelines: [
      'predexec: shell strings for bash; {tool:"read",path:...}, {tool:"grep",pattern:...}, {tool:"find",pattern:...}, {tool:"ls",path:...} for tool calls. ' +
        USAGE_LINE.trimEnd(),
      "predexec: " + RECOVERY_LINE.trimEnd(),
    ],
    parameters: PlanTreeSchema as any,
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
