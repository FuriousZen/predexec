/**
 * predexec stats — request-accounting recorder.
 *
 * Harness-facing (NOT part of pure `core/`): fs + env access lives here. Both
 * adapters call `recordRun` fire-and-forget after `runPlanTree`; the `predexec`
 * bin (`bin/predexec.mjs`) aggregates the same JSONL for `predexec stats`.
 *
 * Persistence is one JSON object per line, append-only — zero native deps
 * (deliberately not SQLite). A stats failure must NEVER break a tool call:
 * every path in here swallows errors, mirroring the condition evaluator's
 * total/exception-safe invariant.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CoreResult, PlanTree } from "./core/index.ts";

export type Harness = "pi" | "opencode";

/** One recorded run — one JSONL line. Bump `v` on schema changes. */
export interface StatsRecord {
  v: 1;
  ts: number;
  harness: Harness;
  stoppedReason: CoreResult["stoppedReason"];
  depthReached: number;
  /** Nodes actually visited (pathTaken length). */
  nodes: number;
  /** Operations (shell commands + tool ops) across visited nodes. */
  ops: number;
  edgesEvaluated: number;
  edgesMatched: number;
  requestsSaved: number;
}

/**
 * Resolve the stats file path: $PREDEXEC_STATE_DIR → $XDG_STATE_HOME/predexec →
 * ~/.local/state/predexec, file stats.jsonl. Keep in sync with bin/predexec.mjs
 * (plain-JS twin — asserted equal by __tests__/stats.test.ts).
 */
export function statsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir =
    env.PREDEXEC_STATE_DIR ||
    (env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "predexec") : join(homedir(), ".local", "state", "predexec"));
  return join(dir, "stats.jsonl");
}

/**
 * Conservative "requests saved" estimate: each operation executed inside the
 * walked path would otherwise have been roughly one tool-call round-trip, so a
 * plan that ran N ops in one predexec call saved ~N-1 requests. Counts only
 * nodes actually visited; same formula for leaf and fallback stops (work
 * already done is still saved). Never negative.
 */
export function estimateRequestsSaved(plan: PlanTree, result: CoreResult): number {
  try {
    const visited = new Set(result.pathTaken);
    let ops = 0;
    for (const node of plan.nodes ?? []) {
      if (visited.has(node.id)) ops += node.commands?.length ?? 0;
    }
    return Math.max(0, ops - 1);
  } catch {
    return 0;
  }
}

/**
 * Append one run record. Fire-and-forget: callers `void recordRun(...)`; all
 * errors (unwritable dir, full disk, weird env) are swallowed.
 */
export async function recordRun(plan: PlanTree, result: CoreResult, harness: Harness): Promise<void> {
  try {
    const visited = new Set(result.pathTaken);
    let ops = 0;
    for (const node of plan.nodes ?? []) {
      if (visited.has(node.id)) ops += node.commands?.length ?? 0;
    }
    const record: StatsRecord = {
      v: 1,
      ts: Date.now(),
      harness,
      stoppedReason: result.stoppedReason,
      depthReached: result.depthReached,
      nodes: result.pathTaken.length,
      ops,
      edgesEvaluated: result.edgesEvaluated,
      edgesMatched: result.edgesMatched,
      requestsSaved: estimateRequestsSaved(plan, result),
    };
    const file = statsFilePath();
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Stats must never break a tool call.
  }
}
