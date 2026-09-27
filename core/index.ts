/**
 * predexec core — public surface. Pure TS, zero harness imports.
 * Adapters import only from here.
 *
 * Narrowed to exactly what the runtime harness adapters (pi, opencode, MCP)
 * and their shared helpers (adapter-runtime.ts, policy.ts, stats.ts, steering.ts) import:
 * plan execution, plan coercion, destructive-command checking, and
 * shell inspection (segment splitting, tokenizing, wrapper stripping) — plus a regex-escaping helper and the
 * plan/result/tool types those functions' signatures require.
 * Focused tests import evaluator, runner, and validation internals directly
 * from their owning files (core/conditions.ts, core/runner.ts,
 * core/engine.ts, core/coerce.ts) instead of through this barrel.
 */

export { runPlanTree } from "./engine.ts";
export { OUTPUT_CAP } from "./runner.ts";
export { isDestructiveCommand } from "./destructive.ts";
export { coercePlan } from "./coerce.ts";
export { escapeRegExp, isSafeRegex } from "./conditions.ts";
export { validateOperation } from "./validation.ts";
export {
  inspectCommandSubstitutionTree,
  lexShellWords,
  splitCommandSegments,
  stripLeadingAssignmentsAndWrappers,
  tokenizeShellWords,
  type ShellWord,
  type WrapperInspectionOptions,
} from "./shell/inspection.ts";
export {
  ANY_HEAD,
  commandsWithUnresolvableOperands,
  describeUnresolvableOperand,
  operandHeadMayReadPaths,
  ruleHeadCouldMatch,
  type UnresolvableOperand,
} from "./shell/operands.ts";
export { inlineProgramReadPaths, type InlineProgramReads } from "./shell/program-reads.ts";
export {
  MAX_OPERATIONS_PER_NODE,
  MAX_PARALLEL_CONCURRENCY,
  MAX_PLAN_NODES,
  MAX_PLAN_EDGES,
  MAX_COMMAND_LENGTH,
  MAX_CLASSIFY_WORD_LENGTH,
  MAX_NODE_ID_LENGTH,
  MAX_CONDITION_LENGTH,
  MAX_CONDITION_TOTAL_LENGTH,
  MAX_JSON_VALUE_DEPTH,
  MAX_JSON_VALUE_NODES,
  MAX_JSON_VALUE_STRING_LENGTH,
  MAX_READ_LINES,
  MAX_SEARCH_RESULTS,
  MAX_GREP_RESULTS,
  MAX_FIND_RESULTS,
  MAX_GREP_PATTERN_LENGTH,
  MAX_LS_ENTRIES,
  MAX_GREP_CONTEXT,
  type ToolOp,
  type Operation,
  type OperationPolicyChecker,
  type PolicyVerdict,
  type PolicyCheckContext,
  type HostPolicyDenial,
  type PlanTree,
  type CoreResult,
  type ToolExecutor,
  type RunOptions,
} from "./types.ts";
