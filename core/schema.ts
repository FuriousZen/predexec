/**
 * predexec core — canonical plan-tree schema, authored ONCE as plain JSON Schema.
 *
 * Dependency-free on purpose: core imports no schema library. Each adapter
 * converts this to its harness's dialect (pi → typebox, opencode → zod, MCP →
 * pass-through). The descriptions here are the low-token "prompting" surface —
 * they teach the DSL in-band rather than via fat system-prompt text.
 *
 * The engine never consumes this; it operates on already-parsed PlanTree objects
 * (types.ts). This is solely the registration/validation contract for adapters.
 */

export const CONDITION_JSON_SCHEMA = {
  oneOf: [
    {
      type: "object",
      description: "HIGH-confidence: exit code of the node's batch (may gate deeper speculation).",
      properties: {
        kind: { const: "exitCode" },
        op: { enum: ["eq", "ne", "lt", "gt"] },
        value: { type: "number" },
      },
      required: ["kind", "op", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "HIGH-confidence: a path exists (relative to cwd).",
      properties: {
        kind: { const: "fileExists" },
        path: { type: "string" },
        negate: { type: "boolean" },
      },
      required: ["kind", "path"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "HIGH-confidence: JSON value at a dot/bracket path in stdout, e.g. 'scripts.test'.",
      properties: {
        kind: { const: "jsonPath" },
        source: { const: "stdout" },
        path: { type: "string" },
        op: { enum: ["eq", "ne", "exists"] },
        value: {},
      },
      required: ["kind", "source", "path", "op"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "HIGH-confidence: number extracted from stdout by a regex (capture group 1 or whole match), compared.",
      properties: {
        kind: { const: "numeric" },
        source: { const: "stdout" },
        extract: { type: "string" },
        op: { enum: ["lt", "le", "gt", "ge", "eq"] },
        value: { type: "number" },
      },
      required: ["kind", "source", "extract", "op", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "LOW-confidence (fuzzy): regex over stdout/stderr. May branch ONLY to a read-only node — never gate a mutating one.",
      properties: {
        kind: { const: "match" },
        source: { enum: ["stdout", "stderr"] },
        regex: { type: "string" },
        negate: { type: "boolean" },
      },
      required: ["kind", "source", "regex"],
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Unconditional edge — only for a step that does NOT depend on the previous node's result; otherwise gate with a verifying predicate so a wrong assumption falls back.",
      properties: { kind: { const: "always" } },
      required: ["kind"],
      additionalProperties: false,
    },
  ],
} as const;

export const PLAN_NODE_JSON_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Unique node id, referenced by edges." },
    commands: {
      type: "array",
      items: { type: "string" },
      description:
        "Shell command BATCH run at this node. Sequential (stop-on-first-error) unless parallel. Put independent steps here together (use parallel) rather than splitting them into separate nodes.",
    },
    parallel: {
      type: "boolean",
      description:
        "Run commands concurrently instead of sequentially. Default false. Use for independent commands batched in the same node.",
    },
    mutates: {
      type: "boolean",
      description:
        "Set true ONLY for filesystem writes/installs/deletes (e.g. npm install, rm, writing/moving a file). Running tests/builds/linters, git status/diff, and cat/ls/grep are READ-ONLY — do NOT set it for them. predexec is read-only: a mutating node HARD-STOPS before running, so don't include install/write steps in the plan at all — do those afterward with normal tools.",
    },
    edges: {
      type: "array",
      description:
        "Branch conditions, evaluated in order; first match wins. Omit for a leaf (path ends). Add only when the next commands depend on THIS node's output; independent steps belong in this node's batch, not a child node.",
      items: {
        type: "object",
        properties: {
          when: CONDITION_JSON_SCHEMA,
          to: { type: "string", description: "Target node id." },
        },
        required: ["when", "to"],
        additionalProperties: false,
      },
    },
  },
  required: ["id", "commands"],
  additionalProperties: false,
} as const;

export const PLAN_TREE_JSON_SCHEMA = {
  type: "object",
  description:
    "A predexec plan tree. Plan as DEEP as you can confidently predict each branch; depth 0 (one node, no edges) is valid and expected — that's just running a command. Use high-confidence predicates (exitCode/fileExists/jsonPath/numeric) to gate depth; use 'match' only to branch to another read-only probe.",
  properties: {
    root: { type: "string", description: "Id of the starting node." },
    nodes: { type: "array", items: PLAN_NODE_JSON_SCHEMA },
    cwd: {
      type: "string",
      description:
        "Base dir for ALL commands and fileExists checks — set once instead of prefixing every command with cd. Relative to the session cwd.",
    },
    maxDepth: { type: "number", description: "Optional cap on speculation depth." },
  },
  required: ["root", "nodes"],
  additionalProperties: false,
} as const;
