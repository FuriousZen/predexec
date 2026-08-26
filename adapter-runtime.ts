/**
 * predexec adapter runtime — unified execution seam for harness adapters.
 *
 * All harness adapters (pi, opencode, Claude Code MCP) delegate plan execution
 * here. Owns the repeated cross-harness pipeline:
 *
 *   raw input -> coercePlan -> runPlanTree -> recordRun -> CoreResult
 *                error -------------------------------> error CoreResult
 *
 * Pure orchestration: tool execution, permissions, progress mapping,
 * and result rendering remain in each adapter.
 */

import { coercePlan, runPlanTree, type CoreResult, type PlanTree, type RunOptions } from "./core/index.ts";
import { recordRun, type Harness } from "./stats.ts";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function errorResult(transcript: string): CoreResult {
  return {
    transcript,
    pathTaken: [],
    depthReached: 0,
    stoppedReason: "error",
    fellBack: true,
    terminal: false,
    edgesEvaluated: 0,
    edgesMatched: 0,
  };
}

export async function executeAdapterPlan(
  rawPlan: unknown,
  harness: Harness,
  options: RunOptions,
): Promise<CoreResult> {
  let plan: PlanTree;
  try {
    plan = coercePlan(rawPlan);
  } catch (err) {
    return errorResult(errText(err));
  }

  try {
    const result = await runPlanTree(plan, options);
    await recordRun(plan, result, harness);
    return result;
  } catch (err) {
    return errorResult(
      `predexec: the plan walk failed unexpectedly (${errText(err)}) — this is a predexec bug, not a plan you can fix. ` +
        "Fall back to normal tool calling for this step.",
    );
  }
}
