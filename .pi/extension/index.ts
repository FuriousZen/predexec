/**
 * predexec — pi coding agent adapter (read-only MVP).
 *
 * Registers ONE tool, `predexec`, that runs a pre-planned tree of command
 * batches with deterministic branch conditions in a single model round-trip.
 * All real logic lives in ../../core (pure TS, zero harness imports); this file
 * builds the JSON Schema, wires ctx.cwd + signal + onUpdate, and maps native
 * tool ops (read/grep/find/ls) to pi's tool factories.
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
import { runPlanTree, coercePlan, isDestructiveCommand, type PlanTree, type ToolOp } from "../../core/index.ts";
import { estimateRequestsSaved, recordRun } from "../../stats.ts";

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
      enum: ["exitCode", "fileExists", "jsonPath", "numeric", "match", "always"],
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
    when: {
      description:
        'Condition as object OR shorthand string. ' +
        'Strings: "exit == 0", "exit != 0", "exit > N", "exit < N", ' +
        '"stdout =~ /regex/", "stderr =~ /regex/", "stdout !~ /regex/", ' +
        '"file exists path", "file missing path", "always". ' +
        "Object form (for jsonPath/numeric): see Condition schema.",
    },
    to: { type: "string", description: "Target node id." },
  },
  required: ["when", "to"],
} as const;

const PlanNode = {
  type: "object",
  properties: {
    id: { type: "string", description: "Unique node id." },
    commands: {
      type: "array",
      items: {
        description:
          "Shell command (string) or tool call (object with 'tool' key). " +
          "Read-only tools: read ({tool,path,offset?,limit?}), grep ({tool,pattern,path?,glob?,ignoreCase?}), " +
          "find ({tool,pattern,path?}), ls ({tool,path?}). " +
          "Mutating tools (hard-stop): edit, write.",
      },
      description: "Shell commands and/or tool calls. Sequential (stop-on-first-error) unless parallel:true.",
    },
    parallel: {
      type: "boolean",
      description: "Run commands concurrently instead of sequentially.",
    },
    mutates: {
      type: "boolean",
      description:
        "True ONLY for writes/installs/deletes. Tests/builds/linters/cat/ls/grep are NOT mutating. Mutating nodes hard-stop without running.",
    },
    edges: {
      type: "array",
      items: PlanEdge,
      description: "Conditions evaluated in order; first match wins. Omit for a leaf.",
    },
  },
  required: ["id", "commands"],
} as const;

const PlanTreeSchema = {
  type: "object",
  properties: {
    root: { type: "string", description: "Starting node id." },
    nodes: { type: "array", items: PlanNode },
    cwd: {
      type: "string",
      description: "Base dir for commands and fileExists (relative to session cwd).",
    },
    maxDepth: { type: "number", description: "Cap on speculation depth." },
  },
  required: ["root", "nodes"],
};

const DESCRIPTION =
  "Run read-only shell commands and tool calls with deterministic branching. " +
  "Each node runs shell commands (strings) and/or tool calls ({tool, ...args}) sequentially or concurrently. " +
  "Edges evaluate conditions on output to choose the next node with no model call between levels.";

type TextContent = { type: "text"; text: string };

function createToolExecutor(cwd: string, signal?: AbortSignal) {
  const tools: Record<string, { execute: (id: string, params: any, signal?: AbortSignal) => Promise<{ content: { type: string; text?: string }[]; details?: unknown }> }> = {
    read: createReadTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
  };

  return async (op: ToolOp, opts: { cwd: string; signal?: AbortSignal }) => {
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
      return { stdout, stderr: "", exitCode: 0 };
    } catch (err) {
      return { stdout: "", stderr: (err as Error).message, exitCode: 1 };
    }
  };
}

const BASH_NUDGE =
  '[predexec] Batch read-only commands in one predexec call: {"root":"a","nodes":[{"id":"a","commands":["cmd1","cmd2"],"parallel":true}]}';

// coercePlan is now in core/coerce.ts — re-export for backward compat with tests
export { coercePlan } from "../../core/index.ts";

export default function predexec(pi: ExtensionAPI): void {
  // Routing steering is delivered declaratively via the `predexec` skill
  // (skills/predexec/SKILL.md, registered through package.json `pi.skills`) plus
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
      'predexec: shell strings for bash; {tool:"read",path:...}, {tool:"grep",pattern:...}, {tool:"find",pattern:...}, {tool:"ls",path:...} for tool calls. Use parallel:true for independent reads, cwd for a shared base dir, and edges to branch.',
      "predexec: mutationStop/noEdgeMatch is recoverable — read the transcript and resume with bash. Never retry the same plan blindly.",
    ],
    parameters: PlanTreeSchema as any,
    async execute(_toolCallId, params: Record<string, unknown>, signal, onUpdate, ctx) {
      let plan: PlanTree;
      try {
        plan = coercePlan(params);
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: (err as Error).message }],
          details: { stoppedReason: "error", fellBack: true },
        };
      }

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

      const result = await runPlanTree(plan, {
        cwd: ctx.cwd,
        signal,
        executeToolOp,
        onProgress(event) {
          if (done) return;
          streamedText = event.transcript;
          emitUpdate(event.transcript, {
            nodeId: event.nodeId,
            depthReached: event.depthReached,
            pathTaken: event.pathTaken,
          });
        },
        onCommandOutput(data) {
          if (done) return;
          streamedText += data;
          scheduleOutputUpdate();
        },
      });

      done = true;
      if (pendingTimeout) clearTimeout(pendingTimeout);
      void recordRun(plan, result, "pi");
      return {
        content: [{ type: "text" as const, text: result.transcript || "(no output)" }],
        details: {
          depthReached: result.depthReached,
          pathTaken: result.pathTaken,
          stoppedReason: result.stoppedReason,
          fellBack: result.fellBack,
          edgesEvaluated: result.edgesEvaluated,
          edgesMatched: result.edgesMatched,
          requestsSaved: estimateRequestsSaved(plan, result),
        },
        // No `terminate` in the read-only MVP: a read-only leaf usually still
        // needs the model. Deferred to impl step 4 (gated mutations + success leaves).
      };
    },
  });
}
