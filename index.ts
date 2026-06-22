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
  "Depth 0 (one node, no edges) is normal execution. Add edges only when the next step depends on this node's output.";

const STEERING =
  "\n\nWhen a task involves multiple shell steps where later steps depend on earlier results " +
  "(e.g. build then test, check then branch), use the `predexec` tool to combine them into " +
  "one call with edges gated on exit codes or output. Use plain `bash` for single commands " +
  "or independent steps with no conditional logic.";

export default function predexec(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + STEERING };
  });

  pi.registerTool({
    name: "predexec",
    label: "predexec",
    description: DESCRIPTION,
    promptSnippet: "Batch independent commands in one node; add edges only on output-dependent branches",
    promptGuidelines: [
      "Independent steps go in ONE node (parallel:true if order doesn't matter). A separate node + edge is only for output-dependent branching.",
      "Read-only only: writes/installs/deletes hard-stop without running. Tests, builds, linters, cat, ls, grep are not mutating.",
      "Conditions read raw stdout/stderr — don't wrap commands in markers or cd prefixes (set cwd on the plan instead).",
    ],
    parameters: PlanTreeSchema,
    async execute(_toolCallId, params: Static<typeof PlanTreeSchema>, signal, _onUpdate, ctx) {
      const result = await runPlanTree(params as unknown as PlanTree, { cwd: ctx.cwd, signal });
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
