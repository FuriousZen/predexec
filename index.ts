/**
 * predexec — pi coding agent adapter (read-only MVP, impl steps 0–1).
 *
 * Registers ONE tool, `predexec`, that runs a pre-planned tree of command
 * batches with deterministic branch conditions in a single model round-trip.
 * All real logic lives in ./core (pure TS, zero harness imports); this file is
 * just: build the typebox schema, wire ctx.cwd + signal, format the result.
 *
 * Type-only import of the pi API keeps zero runtime dependency on the host
 * package (jiti strips `import type`). The only runtime imports are the schema
 * lib (typebox) and StringEnum (provider-compatible enums) — declared as deps
 * so resolution works once this dir is copied into ~/.pi/agent/extensions/.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { runPlanTree, type PlanTree } from "./core/index.ts";

/**
 * Condition is modelled as a single loose object (discriminated by `kind`)
 * rather than a strict union: anyOf/oneOf and literal-union schemas are rejected
 * or mangled by some providers (notably Google). The core evaluator is
 * exception-safe and switches on `kind`, so a superset object is robust. Field
 * descriptions teach which fields pair with which kind.
 */
const Condition = Type.Object(
  {
    kind: StringEnum(["exitCode", "fileExists", "jsonPath", "numeric", "match", "always"], {
      description: "exitCode/fileExists/jsonPath/numeric = high-confidence; match = low-confidence (read-only children only); always = unconditional.",
    }),
    op: Type.Optional(
      StringEnum(["eq", "ne", "lt", "gt", "le", "ge", "exists"], {
        description: "exitCode: eq/ne/lt/gt. numeric: lt/le/gt/ge/eq. jsonPath: eq/ne/exists.",
      }),
    ),
    value: Type.Optional(Type.Any({ description: "Comparison value (exitCode/numeric/jsonPath)." })),
    path: Type.Optional(
      Type.String({ description: "fileExists: path relative to cwd. jsonPath: dot/bracket path in stdout JSON." }),
    ),
    source: Type.Optional(StringEnum(["stdout", "stderr"], { description: "Stream to test (match/numeric/jsonPath)." })),
    extract: Type.Optional(Type.String({ description: "numeric: regex to extract number (group 1 or whole match)." })),
    regex: Type.Optional(Type.String({ description: "match: regex to test." })),
    negate: Type.Optional(Type.Boolean({ description: "Invert result (fileExists/match)." })),
  },
  { description: "Deterministic edge condition." },
);

const PlanEdge = Type.Object({
  when: Condition,
  to: Type.String({ description: "Target node id." }),
});

const PlanNode = Type.Object({
  id: Type.String({ description: "Unique node id." }),
  commands: Type.Array(Type.String(), {
    description: "Shell commands. Sequential (stop-on-first-error) unless parallel:true.",
  }),
  parallel: Type.Optional(
    Type.Boolean({ description: "Run commands concurrently instead of sequentially." }),
  ),
  mutates: Type.Optional(
    Type.Boolean({
      description:
        "True ONLY for writes/installs/deletes. Tests/builds/linters/cat/ls/grep are NOT mutating. Mutating nodes hard-stop without running.",
    }),
  ),
  edges: Type.Optional(
    Type.Array(PlanEdge, {
      description: "Conditions evaluated in order; first match wins. Omit for a leaf.",
    }),
  ),
});

const PlanTreeSchema = Type.Object({
  root: Type.String({ description: "Starting node id." }),
  nodes: Type.Array(PlanNode),
  cwd: Type.Optional(
    Type.String({ description: "Base dir for commands and fileExists (relative to session cwd)." }),
  ),
  maxDepth: Type.Optional(Type.Number({ description: "Cap on speculation depth." })),
});

const DESCRIPTION =
  "Run a tree of shell commands with deterministic branching — no model call between nodes. " +
  "A straight-line sequence that always runs is ONE node with a `commands[]` list (not a chain " +
  "of `always` edges). Independent commands go in one node with `parallel:true`. Add edges ONLY " +
  "when the NEXT command depends on this node's output (exit code / match / fileExists).";

const STEERING =
  "\n\nUse the `predexec` tool for multi-step shell work to save round-trips:" +
  "\n- A pipeline that always runs the same steps = ONE node, all steps in `commands[]`. Do NOT " +
  "wire them as separate nodes joined by `always` edges — that adds no value over one node." +
  "\n- Independent checks (lint AND test AND typecheck) = ONE node with `parallel:true`." +
  "\n- Use edges only for genuine output-dependent branching (e.g. build succeeds → test)." +
  "\n- A `mutationStop` or `noEdgeMatch` result is recoverable, not a failure: read why it " +
  "stopped, fix the plan or resume with plain `bash` — don't abandon the tool. " +
  "Use plain `bash` for a single command.";

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
  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + STEERING };
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
    ],
    parameters: PlanTreeSchema,
    async execute(_toolCallId, params: Static<typeof PlanTreeSchema>, signal, _onUpdate, ctx) {
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
