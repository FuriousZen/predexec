import {
  DEFAULT_MAX_DEPTH,
  MAX_OPERATIONS_PER_NODE,
  MAX_PARALLEL_CONCURRENCY,
  MAX_PLAN_NODES,
  MAX_PLAN_EDGES,
  MAX_COMMAND_LENGTH,
  MAX_NODE_ID_LENGTH,
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

export const PLAN_FIELD_NAMES = Object.freeze({
  root: "root",
  nodes: "nodes",
  id: "id",
  commands: "commands",
  parallel: "parallel",
  mutates: "mutates",
  edges: "edges",
  when: "when",
  to: "to",
  cwd: "cwd",
  maxDepth: "maxDepth",
} as const);

export const JSON_PATH_SINGLE_OP_LINE = "jsonPath edges require a one-operation source node.";
export const PLAN_CWD_DESCRIPTION =
  "Base dir for commands and fileExists: a relative directory inside the session root; absolute or escaping paths are rejected.";

export {
  DEFAULT_MAX_DEPTH,
  MAX_OPERATIONS_PER_NODE,
  MAX_PARALLEL_CONCURRENCY,
  MAX_PLAN_NODES,
  MAX_PLAN_EDGES,
  MAX_COMMAND_LENGTH,
  MAX_NODE_ID_LENGTH,
};

/** Canonical facts shared by model-facing plan descriptions. */
export const PLAN_SHAPE_DESCRIPTION =
  `Plan tree object: {${PLAN_FIELD_NAMES.root}, ${PLAN_FIELD_NAMES.nodes}:[{${PLAN_FIELD_NAMES.id}, ${PLAN_FIELD_NAMES.commands}:[<shell string> | {tool:"read",path,offset?,limit?} | ` +
  '{tool:"grep",pattern,path?,glob?,ignoreCase?,literal?,context?,limit?} | {tool:"find",pattern,path?,limit?} | ' +
  `{tool:"ls",path?,limit?}], ${PLAN_FIELD_NAMES.parallel}?, ${PLAN_FIELD_NAMES.mutates}?, ${PLAN_FIELD_NAMES.edges}?:[{${PLAN_FIELD_NAMES.when},${PLAN_FIELD_NAMES.to}]}]}], ${PLAN_FIELD_NAMES.cwd}?, ${PLAN_FIELD_NAMES.maxDepth}?}. ` +
  'Conditions: exitCode, fileExists, jsonPath, numeric, match, always. ' +
  `Each node has at most ${MAX_OPERATIONS_PER_NODE} operations; parallel execution is capped at ${MAX_PARALLEL_CONCURRENCY} concurrent operations; ` +
  `maxDepth is capped at ${DEFAULT_MAX_DEPTH}; plans have at most ${MAX_PLAN_NODES} nodes and ${MAX_PLAN_EDGES} edges; ` +
  `commands and string arguments are capped at ${MAX_COMMAND_LENGTH} characters. ` +
  `${PLAN_CWD_DESCRIPTION} ${JSON_PATH_SINGLE_OP_LINE} `;
