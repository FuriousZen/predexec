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
import { runPlanTree, type PlanTree } from "./core/index.ts";

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
    when: Condition,
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
  "Batch 2+ shell operations in one round-trip instead of chaining bash/read calls. " +
  "Group a straight pipeline in `commands[]`, independent steps with `parallel:true`, " +
  "and edges only for output-dependent branching. " +
  "One command → bash. One file → read. 2+ shell ops → predexec.";

const STEERING =
  "\n\n## predexec batching\n" +
  "When you need 2+ shell operations (reads, greps, checks), batch them in one predexec " +
  "node instead of chaining bash/read calls — each chained call is a wasted round-trip.\n" +
  "- Straight pipeline → ONE node, commands[] list.\n" +
  "- Independent ops (cat 3 files, lint+test) → ONE node, parallel:true.\n" +
  "- Output-dependent branching → edges (first match wins).\n" +
  "- Precision: use grep/find to locate, then sed/head to extract — avoid cat on large files.\n" +
  "- mutationStop/noEdgeMatch is recoverable: read why, fix the plan or resume with bash.";

const BATCHING_NUDGE =
  "[predexec] You just made consecutive bash/read calls. " +
  "Batch independent shell ops in one predexec node (parallel:true) to save round-trips.";

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
  let bashReadCallsThisTurn = 0;

  pi.on("turn_start", async () => {
    bashReadCallsThisTurn = 0;
  });

  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + STEERING };
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "bash" || event.toolName === "read") {
      bashReadCallsThisTurn++;
      if (bashReadCallsThisTurn >= 2) {
        return {
          content: [
            ...event.content,
            { type: "text" as const, text: `\n\n${BATCHING_NUDGE}` },
          ],
        };
      }
    }
  });

  pi.registerTool({
    name: "predexec",
    label: "predexec",
    description: DESCRIPTION,
    promptSnippet: "One node = a whole pipeline (commands[] or parallel:true); add edges only for output-dependent branches",
    promptGuidelines: [
      "A straight-line pipeline goes in ONE node's commands[]. Independent steps in ONE node with parallel:true. Separate nodes + edges are ONLY for output-dependent branching — never chain steps with `always` edges.",
      "Read-only only: writes/installs/deletes hard-stop without running. Tests, builds, linters, cat, ls, grep are not mutating.",
      "Conditions read raw stdout/stderr — don't wrap commands in markers or cd prefixes (set cwd on the plan instead).",
      "A mutationStop/noEdgeMatch result is recoverable: read the reason, fix the plan or resume with bash — don't drop the tool.",
      "Precision: use grep/find to locate, sed/head to extract — avoid cat on files you haven't verified are small.",
    ],
    parameters: PlanTreeSchema as any,
    async execute(_toolCallId, params: Record<string, unknown>, signal, _onUpdate, ctx) {
      let plan: PlanTree;
      try {
        plan = coercePlan(params);
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: (err as Error).message }],
          details: { stoppedReason: "error", fellBack: true },
        };
      }
      const result = await runPlanTree(plan, { cwd: ctx.cwd, signal });
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
