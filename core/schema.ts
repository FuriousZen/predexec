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
      description: "HIGH: exit code of the node's batch.",
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
      description: "HIGH: path exists (relative to cwd).",
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
      description: "HIGH: JSON value at a dot/bracket path in stdout.",
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
      description: "HIGH: number extracted from stdout by regex, compared.",
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
      description: "LOW: regex over stdout/stderr. May branch only to read-only nodes.",
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
      description: "Unconditional edge.",
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
      description: "Shell commands. Sequential (stop-on-first-error) unless parallel:true.",
    },
    parallel: {
      type: "boolean",
      description: "Run commands concurrently. Default false.",
    },
    mutates: {
      type: "boolean",
      description:
        "True ONLY for writes/installs/deletes. Tests/builds/linters are not mutating. Mutating nodes hard-stop without running.",
    },
    edges: {
      type: "array",
      description: "Conditions evaluated in order; first match wins. Omit for a leaf.",
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
  description: "A plan tree. Depth 0 (one node, no edges) is valid — that's just running commands.",
  properties: {
    root: { type: "string", description: "Id of the starting node." },
    nodes: { type: "array", items: PLAN_NODE_JSON_SCHEMA },
    cwd: {
      type: "string",
      description: "Base dir for commands and fileExists (relative to session cwd).",
    },
    maxDepth: { type: "number", description: "Optional cap on speculation depth." },
  },
  required: ["root", "nodes"],
  additionalProperties: false,
} as const;
