/**
 * predexec core — public surface. Pure TS, zero harness imports.
 * Adapters import only from here.
 *
 * Narrowed to exactly what the runtime harness adapters (pi, opencode, MCP)
 * and their shared helpers (policy.ts, stats.ts) import: plan execution,
 * plan coercion, destructive-command checking, command-segment splitting,
 * and the plan/result/tool types those functions' signatures require.
 * Focused tests import evaluator, runner, and validation internals directly
 * from their owning files (core/conditions.ts, core/runner.ts,
 * core/engine.ts, core/coerce.ts) instead of through this barrel.
 */

export { runPlanTree } from "./engine.ts";
export { isDestructiveCommand, splitCommandSegments } from "./destructive.ts";
export { coercePlan } from "./coerce.ts";
export { type ToolOp, type PlanTree, type CoreResult, type ToolExecutor, type RunOptions, type ProgressEvent } from "./types.ts";
