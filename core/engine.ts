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
import { evaluateConditionWithDetail } from "./conditions.ts";
import {
  READ_ONLY_TOOLS,
  MUTATING_TOOLS,
  findDestructiveToken,
  isDestructiveCommand,
} from "./destructive.ts";
import { runNode, isToolOp, formatToolOpLabel } from "./runner.ts";

export { isDestructiveCommand };
import {
  DEFAULT_MAX_DEPTH,
  HIGH_CONFIDENCE_KINDS,
  type CoreResult,
  type NodeOutput,
  type Operation,
  type PlanNode,
  type PlanTree,
  type RunOptions,
  type StoppedReason,
  type ToolOp,
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
    const detected = current.mutates ? null : findDestructive(current);
    if (current.mutates || detected) {
      blocks.push(mutationBlock(current, detected));
      return result(pathTaken, depth, "mutationStop", blocks.join("\n\n"), edgesEvaluated, edgesMatched);
    }

    // Host-policy hard-stop: the host would deny or prompt for this command;
    // predexec cannot prompt mid-walk, so it never runs it.
    if (opts.checkCommandPolicy) {
      const violation = findPolicyViolation(current, opts.checkCommandPolicy);
      if (violation) {
        blocks.push(policyBlock(current, violation));
        return result(pathTaken, depth, "policyStop", blocks.join("\n\n"), edgesEvaluated, edgesMatched);
      }
    }

    if (opts.signal?.aborted) {
      return result(pathTaken, depth, "aborted", blocks.join("\n\n"), edgesEvaluated, edgesMatched);
    }

    const output = await runNode(current, runOpts);
    pathTaken.push(current.id);
    blocks.push(transcriptBlock(current, output));

    opts.onProgress?.({
      nodeId: current.id,
      transcript: blocks.join("\n\n"),
      pathTaken: [...pathTaken],
      depthReached: depth,
    });

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
    const misses: string[] = [];
    for (const edge of edges) {
      edgesEvaluated++;
      const { result: matched, detail } = evaluateConditionWithDetail(output, edge.when, effectiveCwd);
      if (matched) {
        edgesMatched++;
        next = byId.get(edge.to)!;
        break;
      }
      misses.push(`- → ${edge.to}: ${detail}`);
    }

    if (!next) {
      // Echo what each condition saw, so the model fixes the condition instead
      // of guessing why the walk stopped.
      blocks.push([`No edge matched from node ${current.id}:`, ...misses].join("\n"));
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

/**
 * Conservative backstop for an undeclared write/install/delete. Defense in depth.
 * Returns the offending command (+ matched token) so the hard-stop can tell the
 * model exactly what tripped it; null if the node is read-only.
 */
function findDestructive(node: PlanNode): { index: number; command: string; token: string } | null {
  for (let i = 0; i < node.commands.length; i++) {
    const op = node.commands[i]!;
    if (isToolOp(op)) {
      const result = checkToolOpDestructive(op);
      if (result) return { index: i, command: formatToolOpLabel(op), token: result };
      continue;
    }
    const token = findDestructiveToken(op);
    if (token) return { index: i, command: op, token };
  }
  return null;
}

function checkToolOpDestructive(op: ToolOp): string | null {
  if (READ_ONLY_TOOLS.has(op.tool)) return null;
  if (MUTATING_TOOLS.has(op.tool)) return `tool:${op.tool}`;
  if (op.tool === "bash" && typeof op.command === "string") {
    return findDestructiveToken(op.command);
  }
  return `unknown tool:${op.tool}`;
}

/**
 * Host-policy check over a node's shell strings (incl. `{tool:"bash"}` ops).
 * Runs the adapter-provided checker; a hit means the HOST would deny or prompt
 * for this command — predexec cannot prompt mid-walk, so it hard-stops before
 * running, same contract as the mutation stop.
 */
function findPolicyViolation(
  node: PlanNode,
  check: (cmd: string) => string | null,
): { index: number; command: string; rule: string } | null {
  for (let i = 0; i < node.commands.length; i++) {
    const op = node.commands[i]!;
    const cmd = isToolOp(op)
      ? op.tool === "bash" && typeof op.command === "string"
        ? op.command
        : null
      : op;
    if (cmd === null) continue;
    const rule = check(cmd);
    if (rule) return { index: i, command: cmd, rule };
  }
  return null;
}

function transcriptBlock(node: PlanNode, output: NodeOutput): string {
  const lines = [`## node ${node.id} (exit ${output.exitCode})`];
  const toolOps = node.commands.filter(isToolOp);
  if (toolOps.length > 0) {
    lines.push(toolOps.map((op) => `[${formatToolOpLabel(op)}]`).join(" "));
  }
  if (output.stdout) lines.push("stdout:", output.stdout.trimEnd());
  if (output.stderr) lines.push("stderr:", output.stderr.trimEnd());
  const truncated =
    output.stdout?.includes("…[truncated]") || output.stderr?.includes("…[truncated]");
  if (truncated) {
    const hasReadOps = toolOps.some((op) => op.tool === "read");
    const hasShellCmds = node.commands.some((c) => typeof c === "string");
    if (hasReadOps && !hasShellCmds) {
      lines.push("⚠ Output truncated. Use read with offset to continue from where it stopped.");
    } else if (hasReadOps) {
      lines.push("⚠ Output truncated. Use read with offset or tail/sed -n/head to continue from where it stopped.");
    } else {
      lines.push("⚠ Output truncated. Use tail/sed -n/head with an offset to continue from where it stopped.");
    }
  }
  return lines.join("\n");
}

function formatOp(op: Operation): string {
  return isToolOp(op) ? formatToolOpLabel(op) : op;
}

function mutationBlock(
  node: PlanNode,
  detected: { index: number; command: string; token: string } | null,
): string {
  const lines = [
    `## node ${node.id} — MUTATION HARD-STOP (not run)`,
    `commands: ${node.commands.map(formatOp).join(node.parallel ? " & " : " ; ")}`,
  ];
  if (detected) {
    lines.push(
      `Blocked by token \`${detected.token}\` in command ${detected.index + 1}: ${detected.command}`,
      "If that token is a comparison (e.g. inside awk/`[[ ]]`/`(( ))`) or a quoted string/pattern " +
        "and NOT a write, isolate it in its own node or rephrase, then retry.",
    );
  } else {
    lines.push("Declared mutates:true.");
  }
  lines.push("Speculation stops before any write/install/delete. Resume with normal tool calling to perform it.");
  return lines.join("\n");
}

function policyBlock(
  node: PlanNode,
  violation: { index: number; command: string; rule: string },
): string {
  return [
    `## node ${node.id} — POLICY HARD-STOP (not run)`,
    `Blocked by host permission rule '${violation.rule}' on command ${violation.index + 1}: ${violation.command}`,
    "Run this via the host bash tool instead — it enforces/prompts per the host's permission config.",
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
