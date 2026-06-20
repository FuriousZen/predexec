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
      description:
        "Predicate type. HIGH-confidence (exitCode/fileExists/jsonPath/numeric) may gate deeper speculation; LOW (match) may branch only to a read-only node; always = unconditional (prefer a verifying predicate when the next step depends on this result).",
    }),
    op: Type.Optional(
      StringEnum(["eq", "ne", "lt", "gt", "le", "ge", "exists"], {
        description: "Comparison op. exitCode: eq/ne/lt/gt. numeric: lt/le/gt/ge/eq. jsonPath: eq/ne/exists.",
      }),
    ),
    value: Type.Optional(Type.Any({ description: "Comparison value for exitCode/numeric/jsonPath." })),
    path: Type.Optional(
      Type.String({ description: "fileExists: a path (relative to cwd). jsonPath: dot/bracket path in stdout, e.g. 'scripts.test'." }),
    ),
    source: Type.Optional(StringEnum(["stdout", "stderr"], { description: "Output stream for match/numeric/jsonPath." })),
    extract: Type.Optional(Type.String({ description: "numeric: regex extracting a number (capture group 1 or whole match)." })),
    regex: Type.Optional(Type.String({ description: "match: regex tested against the chosen source." })),
    negate: Type.Optional(Type.Boolean({ description: "Invert the result (fileExists / match)." })),
  },
  { description: "A deterministic edge condition." },
);

const PlanEdge = Type.Object({
  when: Condition,
  to: Type.String({ description: "Target node id." }),
});

const PlanNode = Type.Object({
  id: Type.String({ description: "Unique node id, referenced by edges." }),
  commands: Type.Array(Type.String(), {
    description:
      "Shell command BATCH run at this node. Sequential (stop-on-first-error) unless parallel. Put independent steps here together (use parallel) rather than splitting them into separate nodes.",
  }),
  parallel: Type.Optional(
    Type.Boolean({ description: "Run commands concurrently. Default false. Use for independent commands batched in the same node." }),
  ),
  mutates: Type.Optional(
    Type.Boolean({
      description:
        "Set true ONLY for filesystem writes/installs/deletes (e.g. npm install, rm, writing/moving a file). Running tests/builds/linters, git status/diff, and cat/ls/grep are READ-ONLY — do NOT set it for them. predexec is read-only: a mutating node HARD-STOPS before running, so don't include install/write steps in the plan at all — do those afterward with normal tools.",
    }),
  ),
  edges: Type.Optional(
    Type.Array(PlanEdge, {
      description:
        "Branch conditions, in order; first match wins. Omit for a leaf (path ends). Add edges only when the next commands depend on THIS node's output; independent steps belong in this node's batch, not a child node.",
    }),
  ),
});

const PlanTreeSchema = Type.Object({
  root: Type.String({ description: "Id of the starting node." }),
  nodes: Type.Array(PlanNode),
  cwd: Type.Optional(
    Type.String({
      description:
        "Base dir for ALL commands and fileExists checks — set once instead of prefixing every command with `cd`. Relative to the session cwd.",
    }),
  ),
  maxDepth: Type.Optional(Type.Number({ description: "Optional cap on speculation depth." })),
});

const DESCRIPTION =
  "Execute a pre-planned tree of command batches in ONE round-trip; the engine walks it with no model call " +
  "between nodes. A node is a command BATCH: put independent commands in ONE node (set parallel) — a single " +
  "batched node with no edges is the expected default and behaves exactly like running them normally. Add a " +
  "child node + edge ONLY when its commands depend on a previous node's OUTPUT — a branch you'd otherwise " +
  "spend a round-trip to resolve. That output-dependent branch is predexec's only real win; everything else " +
  "is just a batch. Returns when it hits a leaf, a non-matching branch (falls back to normal tools), the " +
  "depth cap, or a mutating node (hard stop before any write) — predexec is read-only, so plan only " +
  "read-only probes/tests/builds and leave writes/installs for afterward.";

export default function predexec(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "predexec",
    label: "predexec",
    description: DESCRIPTION,
    promptSnippet: "Batch independent commands into one predexec node; add a branch only on output you must see first",
    promptGuidelines: [
      "A node is a command BATCH: put all independent steps in ONE node (set parallel:true) — do NOT split independent steps into separate nodes. Most tasks are a single node with no edges (depth 0), which behaves exactly like running the commands normally.",
      "Add a child node + edge ONLY when the next commands depend on THIS node's OUTPUT (e.g. run the build, then branch on whether it failed). If a later step doesn't need an earlier step's output, it is not a branch — batch it.",
      "Gate depth with high-confidence predicates (exitCode/fileExists/jsonPath/numeric); use 'match' only to branch to another read-only probe.",
      "Verify before you descend: gate each step on a predicate confirming the previous step's assumption (e.g. fileExists the file you're about to read) instead of chaining 'always', so a wrong guess fails fast to fallback.",
      "All commands run in the session cwd (shown as '# cwd:' in the result); set the plan's cwd once — don't prefix commands with 'cd', and don't wrap commands in echo '===MARKER===' scaffolding (conditions read raw stdout/stderr).",
      "predexec is READ-ONLY: don't put writes/installs/deletes in a plan (they hard-stop and run nothing — do them afterward with normal tools). Running tests/builds/linters/probes is NOT mutating; never set mutates:true on them.",
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
