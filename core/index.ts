/**
 * predexec core — public surface. Pure TS, zero harness imports.
 * Adapters import only from here.
 */

export { runPlanTree, validatePlan } from "./engine.ts";
export { evaluateCondition, parseConditionString } from "./conditions.ts";
export { runNode, isToolOp, formatToolOpLabel, OUTPUT_CAP } from "./runner.ts";
export {
  PLAN_TREE_JSON_SCHEMA,
  PLAN_NODE_JSON_SCHEMA,
  CONDITION_JSON_SCHEMA,
} from "./schema.ts";
export {
  DEFAULT_MAX_DEPTH,
  HIGH_CONFIDENCE_KINDS,
  type NodeId,
  type ToolOp,
  type Operation,
  type PlanNode,
  type PlanEdge,
  type Condition,
  type ConditionKind,
  type PlanTree,
  type NodeOutput,
  type StoppedReason,
  type CoreResult,
  type ToolExecutor,
  type RunOptions,
} from "./types.ts";
