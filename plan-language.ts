import {
  DEFAULT_MAX_DEPTH,
  MAX_OPERATIONS_PER_NODE,
  MAX_PARALLEL_CONCURRENCY,
} from "./core/types.ts";

export const CONDITION_KINDS = Object.freeze([
  "exitCode",
  "fileExists",
  "jsonPath",
  "numeric",
  "match",
  "always",
] as const);

export const TOOL_OPERATION_NAMES = Object.freeze(["read", "grep", "find", "ls"] as const);

export const PLAN_FIELD_NAMES = Object.freeze([
  "root",
  "nodes",
  "id",
  "commands",
  "parallel",
  "mutates",
  "edges",
  "when",
  "to",
  "cwd",
  "maxDepth",
] as const);

export const JSON_PATH_SINGLE_OP_LINE = "jsonPath edges require a one-operation source node.";

export { DEFAULT_MAX_DEPTH, MAX_OPERATIONS_PER_NODE, MAX_PARALLEL_CONCURRENCY };

/** Canonical facts shared by model-facing plan descriptions. */
export const PLAN_SHAPE_DESCRIPTION =
  'Plan tree object: {root, nodes:[{id, commands:[<shell string> | {tool:"read",path,offset?,limit?} | ' +
  '{tool:"grep",pattern,path?,glob?,ignoreCase?,literal?,context?,limit?} | {tool:"find",pattern,path?,limit?} | ' +
  '{tool:"ls",path?,limit?}], parallel?, mutates?, edges?:[{when,to}]}], cwd?, maxDepth?}. ' +
  'Conditions: exitCode, fileExists, jsonPath, numeric, match, always. ' +
  `Each node has at most ${MAX_OPERATIONS_PER_NODE} operations; parallel execution is capped at ${MAX_PARALLEL_CONCURRENCY} concurrent operations; ` +
  `maxDepth is capped at ${DEFAULT_MAX_DEPTH}. ` +
  `cwd must be a relative directory inside the session root. ${JSON_PATH_SINGLE_OP_LINE} `;
