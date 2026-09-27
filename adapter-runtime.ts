/**
 * predexec adapter runtime — unified execution seam for harness adapters.
 *
 * All harness adapters (pi, opencode, Claude Code MCP) delegate plan execution
 * here. Owns the repeated cross-harness pipeline:
 *
 *   raw input -> coercePlan -> runPlanTree -> recordRun -> CoreResult
 *                error -------------------------------> error CoreResult
 *
 * It also loads the user-level classifier config (user-config.ts) once per
 * plan run and hands it to the engine's mutation gate, so every adapter
 * classifies with the same options.
 *
 * Pure orchestration: tool execution, permissions, progress mapping,
 * and result rendering remain in each adapter.
 */

import {
  type ClassifierOptions,
  coercePlan,
  runPlanTree,
  type CoreResult,
  type PlanTree,
  type RunOptions,
} from "./core/index.ts";
import { recordRun, type Harness } from "./stats.ts";
import { loadUserConfig, type UserConfig } from "./user-config.ts";

/**
 * The user config as of the latest plan run. Loaded once per plan run (its
 * warnings go in that run's transcript) and reused by classifications
 * between runs, so a native shell call's nudge never re-reads the file.
 */
let latestUserConfig: UserConfig | null = null;

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
    return errorResult(`plan validation failed: ${errText(err)}`);
  }

  const userConfig = loadUserConfig();
  latestUserConfig = userConfig;
  let result: CoreResult;
  try {
    result = await runPlanTree(plan, { ...options, classifier: options.classifier ?? userConfig.classifier });
  } catch (err) {
    return errorResult(
      `predexec: the plan walk failed unexpectedly (${errText(err)}) — this is a predexec bug, not a plan you can fix. ` +
        "Fall back to normal tool calling for this step.",
    );
  }

  void recordRun(plan, result, harness);
  // A config problem must not be silent: the user's opt-ins are not in force.
  if (userConfig.warnings.length > 0) {
    result = { ...result, transcript: `${userConfig.warnings.join("\n")}\n\n${result.transcript}` };
  }
  return result;
}

/**
 * The user-level classifier options, for an adapter that classifies outside a
 * plan run (e.g. deciding whether to nudge after a native shell call): the
 * latest plan run's load, or one load if no plan has run yet. Its warnings
 * surface in the next plan run's transcript, which reloads.
 */
export function userClassifierOptions(): ClassifierOptions {
  latestUserConfig ??= loadUserConfig();
  return latestUserConfig.classifier;
}
