/**
 * predexec — pi coding agent adapter (read-only MVP, impl steps 0–1).
 *
 * Registers ONE tool, `predexec`, that runs a pre-planned tree of command
 * batches with deterministic branch conditions in a single model round-trip.
 * All real logic lives in ./core (pure TS, zero harness imports); this file is
 * just: build the JSON Schema, wire ctx.cwd + signal, format the result.
 *
 * Type-only import of the pi API keeps zero runtime dependency on the host
 * package (jiti strips `import type`). The schema is a plain JSON Schema
 * literal — no runtime dependencies.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runPlanTree, parseConditionString, type PlanTree } from "./core/index.ts";

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
      items: { type: "string" },
      description: "Shell commands. Sequential (stop-on-first-error) unless parallel:true.",
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
  "Run read-only shell commands with deterministic branching. " +
  "Commands run sequentially (stop-on-first-error) or concurrently (parallel:true). " +
  "Edges evaluate conditions on output to choose the next node with no model call between levels.";

const BASH_NUDGE =
  "[predexec] Use predexec instead of bash for read-only commands. " +
  "A one-command node with no edges is valid and saves a round-trip if you add more ops later.";

/**
 * Free-tier models routinely emit nested JSON as a STRING (e.g. `nodes` arrives
 * double-encoded, or the whole argument object is stringified). The strict
 * schema rejects that with an opaque "must be object". Recover defensively: parse
 * a stringified plan or a stringified `nodes`, and on failure return a message
 * that says what shape was expected instead of a validator dump.
 */
export function coercePlan(params: unknown): PlanTree {
  let p: unknown = params;
  if (typeof p === "string") p = parseOrThrow(p, "plan");
  if (p && typeof p === "object" && typeof (p as { nodes?: unknown }).nodes === "string") {
    p = { ...(p as object), nodes: parseOrThrow((p as { nodes: string }).nodes, "nodes") };
  }
  const plan = p as PlanTree;
  if (!plan || typeof plan !== "object" || typeof plan.root !== "string" || !Array.isArray(plan.nodes)) {
    throw new Error(
      "predexec expected an object with a string `root` and an array `nodes` (each {id, commands[]}). " +
        "If your harness stringifies arguments, pass the plan as a JSON object, not a string.",
    );
  }
  for (const node of plan.nodes) {
    if (!node.edges) continue;
    for (const edge of node.edges) {
      if (typeof edge.when === "string") {
        const parsed = parseConditionString(edge.when);
        if (!parsed) {
          throw new Error(
            `predexec could not parse condition string "${edge.when}" on edge from "${node.id}". ` +
              `Use: "exit == 0", "stdout =~ /pattern/", "file exists path", "always", or an object.`,
          );
        }
        (edge as { when: unknown }).when = parsed;
      }
    }
  }
  return plan;
}

function parseOrThrow(s: string, what: string): unknown {
  try {
    return JSON.parse(s);
  } catch (err) {
    throw new Error(`predexec could not parse \`${what}\` as JSON: ${(err as Error).message}`);
  }
}

export default function predexec(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt.replace(
        "Use bash for file operations like ls, rg, find",
        "Use predexec for read-only shell operations. " +
          "Use bash for writes/installs/deletes (predexec hard-stops on those) and interactive commands",
      ),
    };
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "bash") {
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
    promptSnippet: "Default tool for non-mutative shell work — commands, pipelines, and branching sequences",
    promptGuidelines: [
      'Edge conditions can be strings: "exit == 0", "stdout =~ /pattern/", "file exists path", "always". Use object form only for jsonPath/numeric.',
      "Read-only: writes/installs/deletes hard-stop. Tests, builds, linters, cat, ls, grep are not mutating.",
      "mutationStop/noEdgeMatch is recoverable: read the transcript, fix the plan or resume with bash.",
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

      const result = await runPlanTree(plan, {
        cwd: ctx.cwd,
        signal,
        onProgress(event) {
          streamedText = event.transcript;
          emitUpdate(event.transcript, {
            nodeId: event.nodeId,
            depthReached: event.depthReached,
            pathTaken: event.pathTaken,
          });
        },
        onCommandOutput(data) {
          streamedText += data;
          scheduleOutputUpdate();
        },
      });

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
        // needs the model. Deferred to impl step 4 (gated mutations + success leaves).
      };
    },
  });
}
