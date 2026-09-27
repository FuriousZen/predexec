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
import { loadUserConfig, sessionTrustProblem, type UserConfig } from "./user-config.ts";

/**
 * The user config as of the latest plan run. Loaded once per plan run (its
 * warnings go in that run's transcript) and reused by classifications
 * between runs, so a native shell call's nudge never re-reads the file.
 */
let latestUserConfig: UserConfig | null = null;

/** MCP hosts, whose server stderr is not a user's terminal UI. */
const STDERR_HOSTS: ReadonlySet<Harness> = new Set(["claude-code", "codex", "antigravity"]);

/**
 * The user config for a session rooted at `sessionRoot`. R63: when the
 * repository could have chosen the allowlists (sessionTrustProblem), they are
 * dropped, with a warning — fail closed.
 */
function loadSessionUserConfig(sessionRoot: string, harness?: Harness): UserConfig {
  const config = loadUserConfig();
  const problem = sessionTrustProblem({ sessionRoot, host: harness });
  if (problem === null) return config;
  const warning = `predexec: user allowlists disabled for this session: ${problem}`;
  if (harness !== undefined && STDERR_HOSTS.has(harness)) process.stderr.write(`${warning}\n`);
  return { classifier: {}, warnings: [...config.warnings, warning] };
}

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

  const userConfig = loadSessionUserConfig(options.cwd ?? process.cwd(), harness);
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
  latestUserConfig ??= loadSessionUserConfig(process.cwd());
  return latestUserConfig.classifier;
}
