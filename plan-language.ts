import {
  DEFAULT_MAX_DEPTH,
  MAX_OPERATIONS_PER_NODE,
  MAX_PARALLEL_CONCURRENCY,
  MAX_PLAN_NODES,
  MAX_PLAN_EDGES,
  MAX_COMMAND_LENGTH,
  MAX_NODE_ID_LENGTH,
  MAX_CONDITION_LENGTH,
  MAX_CONDITION_TOTAL_LENGTH,
  MAX_READ_LINES,
  MAX_SEARCH_RESULTS,
  MAX_GREP_RESULTS,
  MAX_FIND_RESULTS,
  MAX_GREP_PATTERN_LENGTH,
  MAX_LS_ENTRIES,
  MAX_GREP_CONTEXT,
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
export const RESOURCE_LIMIT_DESCRIPTION =
  `Native operation ceilings: read limit at most ${MAX_READ_LINES} lines; grep/find limit at most ${MAX_SEARCH_RESULTS} results; ` +
  `ls limit at most ${MAX_LS_ENTRIES} entries; grep context at most ${MAX_GREP_CONTEXT} lines per side; ` +
  `grep patterns are capped at ${MAX_GREP_PATTERN_LENGTH} characters. ` +
  "Limits and offsets are positive integers; grep context may be zero. Omitted values use adapter defaults.";

export {
  DEFAULT_MAX_DEPTH,
  MAX_OPERATIONS_PER_NODE,
  MAX_PARALLEL_CONCURRENCY,
  MAX_PLAN_NODES,
  MAX_PLAN_EDGES,
  MAX_COMMAND_LENGTH,
  MAX_NODE_ID_LENGTH,
  MAX_CONDITION_LENGTH,
  MAX_CONDITION_TOTAL_LENGTH,
  MAX_READ_LINES,
  MAX_SEARCH_RESULTS,
  MAX_GREP_RESULTS,
  MAX_FIND_RESULTS,
  MAX_GREP_PATTERN_LENGTH,
  MAX_LS_ENTRIES,
  MAX_GREP_CONTEXT,
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
  `Condition strings and paths are capped at ${MAX_CONDITION_LENGTH} characters per field and ${MAX_CONDITION_TOTAL_LENGTH} characters in aggregate; ` +
  `${PLAN_CWD_DESCRIPTION} ${RESOURCE_LIMIT_DESCRIPTION} ${JSON_PATH_SINGLE_OP_LINE} `;
