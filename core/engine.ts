/**
 * predexec core — traversal engine.
 *
 * runPlanTree walks the plan tree deterministically: run a node, evaluate its
 * outgoing edges (first match wins), descend to the child — with NO model call
 * between levels. It stops and hands back to the normal agent loop on any of:
 *   - leaf            (no edges)               => success path complete
 *   - noEdgeMatch     (no edge matched)        => benign miss, resume the loop
 *   - maxDepth        (depth cap hit)
 *   - mutationStop    (next node mutates)      => hard stop BEFORE the write
 *   - error           (invalid plan)
 *   - aborted         (signal)
 *
 * "Fallback" is not special machinery: on any non-leaf stop we just return the
 * transcript + pathTaken as an ordinary result and the agent resumes.
 */

import { resolve } from "node:path";
import { evaluateCondition } from "./conditions.ts";
import { runNode } from "./runner.ts";
import {
  DEFAULT_MAX_DEPTH,
  HIGH_CONFIDENCE_KINDS,
  type CoreResult,
  type NodeOutput,
  type PlanNode,
  type PlanTree,
  type RunOptions,
  type StoppedReason,
} from "./types.ts";

export async function runPlanTree(plan: PlanTree, opts: RunOptions): Promise<CoreResult> {
  const byId = new Map<string, PlanNode>();
  const validationError = validatePlan(plan, byId);
  if (validationError) {
    return result([], 0, "error", `plan validation failed: ${validationError}`, 0, 0);
  }

  const effectiveCwd = plan.cwd ? resolve(opts.cwd, plan.cwd) : opts.cwd;
  const runOpts: RunOptions = { ...opts, cwd: effectiveCwd };

  const maxDepth = plan.maxDepth ?? DEFAULT_MAX_DEPTH;
  const pathTaken: string[] = [];
  // Surface the working dir so the model sees commands already run here and need
  // not prefix each one with `cd`.
  const blocks: string[] = [`# cwd: ${effectiveCwd}`];
  let edgesEvaluated = 0;
  let edgesMatched = 0;

  let current = byId.get(plan.root)!;
  let depth = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Mutation hard-stop: never RUN a mutating node in the read-only MVP.
    const destructive = current.mutates || hasDestructiveCommand(current);
    if (destructive) {
      blocks.push(mutationBlock(current));
      return result(pathTaken, depth, "mutationStop", blocks.join("\n\n"), edgesEvaluated, edgesMatched);
    }

    if (opts.signal?.aborted) {
      return result(pathTaken, depth, "aborted", blocks.join("\n\n"), edgesEvaluated, edgesMatched);
    }

    const output = await runNode(current, runOpts);
    pathTaken.push(current.id);
    blocks.push(transcriptBlock(current, output));

    if (opts.signal?.aborted) {
      return result(pathTaken, depth, "aborted", blocks.join("\n\n"), edgesEvaluated, edgesMatched);
    }

    const edges = current.edges ?? [];
    if (edges.length === 0) {
      // Leaf: the only stop that is NOT a fallback. A zero-exit leaf is terminal.
      return result(
        pathTaken,
        depth,
        "leaf",
        blocks.join("\n\n"),
        edgesEvaluated,
        edgesMatched,
        output.exitCode === 0,
      );
    }

    if (depth + 1 > maxDepth) {
      return result(pathTaken, depth, "maxDepth", blocks.join("\n\n"), edgesEvaluated, edgesMatched);
    }

    let next: PlanNode | undefined;
    for (const edge of edges) {
      edgesEvaluated++;
      if (evaluateCondition(output, edge.when, effectiveCwd)) {
        edgesMatched++;
        next = byId.get(edge.to)!;
        break;
      }
    }

    if (!next) {
      return result(pathTaken, depth, "noEdgeMatch", blocks.join("\n\n"), edgesEvaluated, edgesMatched);
    }

    current = next;
    depth++;
  }
}

/**
 * Pure structural + tier validation. Returns an error string, or null if valid.
 * Tier rule: a LOW-confidence edge (`match`) may not point at a mutating node —
 * only cleanly-separable predicates may gate a mutating child.
 */
export function validatePlan(plan: PlanTree, byId: Map<string, PlanNode>): string | null {
  if (!plan.nodes || plan.nodes.length === 0) return "no nodes";
  for (const node of plan.nodes) {
    if (byId.has(node.id)) return `duplicate node id "${node.id}"`;
    byId.set(node.id, node);
  }
  if (!byId.has(plan.root)) return `root "${plan.root}" is not a node`;

  for (const node of plan.nodes) {
    for (const edge of node.edges ?? []) {
      const target = byId.get(edge.to);
      if (!target) return `edge from "${node.id}" points at missing node "${edge.to}"`;
      if (!HIGH_CONFIDENCE_KINDS.has(edge.when.kind) && target.mutates) {
        return `low-confidence edge (${edge.when.kind}) from "${node.id}" may not gate mutating node "${edge.to}"`;
      }
    }
  }
  return null;
}

/** Conservative backstop for an undeclared write/install/delete. Defense in depth. */
function hasDestructiveCommand(node: PlanNode): boolean {
  if (node.mutates) return true;
  return node.commands.some((c) => DESTRUCTIVE.test(c));
}

const DESTRUCTIVE =
  /\b(rm|rmdir|mv|dd|mkfs|chmod|chown|truncate)\b|\bcp\s+-|(?<![\d&=])>(?!\/dev\/null|[&=])|\b(npm|pnpm|yarn|pip|pip3|apt|apt-get|brew|cargo|go)\s+(install|add|i|remove|uninstall|rm)\b|\bgit\s+(push|commit|reset|checkout|clean|rm)\b/;

function transcriptBlock(node: PlanNode, output: NodeOutput): string {
  // The command itself is already in the plan (tool-call args); echoing it here
  // would re-enter context as input on the follow-up turn. Emit id + exit only.
  const lines = [`## node ${node.id} (exit ${output.exitCode})`];
  if (output.stdout) lines.push("stdout:", output.stdout.trimEnd());
  if (output.stderr) lines.push("stderr:", output.stderr.trimEnd());
  return lines.join("\n");
}

function mutationBlock(node: PlanNode): string {
  return [
    `## node ${node.id} — MUTATION HARD-STOP (not run)`,
    `commands: ${node.commands.join(node.parallel ? " & " : " ; ")}`,
    "Speculation stops before any write/install/delete. Resume with normal tool calling to perform it.",
  ].join("\n");
}

function result(
  pathTaken: string[],
  depthReached: number,
  stoppedReason: StoppedReason,
  transcript: string,
  edgesEvaluated: number,
  edgesMatched: number,
  terminal = false,
): CoreResult {
  return {
    transcript,
    pathTaken,
    depthReached,
    stoppedReason,
    fellBack: stoppedReason !== "leaf",
    terminal,
    edgesEvaluated,
    edgesMatched,
  };
}
