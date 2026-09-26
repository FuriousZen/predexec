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
 *   - policyStop      (host would deny/ask)     => hard stop BEFORE the command
 *   - error           (invalid plan)
 *   - aborted         (signal)
 *
 * "Fallback" is not special machinery: on any non-leaf stop we just return the
 * transcript + pathTaken as an ordinary result and the agent resumes.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { conditionStringBudget, evaluateConditionWithDetail, isInsideRoot } from "./conditions.ts";
import { READ_ONLY_TOOLS, MUTATING_TOOLS, findDestructiveToken } from "./destructive.ts";
import { runNode, isToolOp, formatToolOpLabel } from "./runner.ts";
import { ARGV, extractShellCommandClauses, hasDynamicCommandName, inspectCommandSubstitutionTree, normalizeEnvInvocation, splitCommandSegments, tokenizeShellWords } from "./shell/lexer.ts";
import { shellEvalPayload } from "./shell/interpreters.ts";
import { validateOperation } from "./validation.ts";
import {
  DEFAULT_MAX_DEPTH,
  HIGH_CONFIDENCE_KINDS,
  JSON_PATH_SINGLE_OP_MESSAGE,
  MAX_OPERATIONS_PER_NODE,
  MAX_PLAN_EDGES,
  MAX_PLAN_NODES,
  MAX_COMMAND_LENGTH,
  MAX_NODE_ID_LENGTH,
  type CoreResult,
  type NodeOutput,
  type Operation,
  type OperationPolicyChecker,
  type PolicyCheckContext,
  type PolicyVerdict,
  type HostPolicyDenial,
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

  const cwdResult = resolvePlanCwd(opts.cwd, plan.cwd);
  if ("error" in cwdResult) {
    return result([], 0, "error", cwdResult.error, 0, 0);
  }
  const effectiveCwd = cwdResult.cwd;
  const runOpts: RunOptions = { ...opts, cwd: effectiveCwd };

  // maxDepth is model-authored, so it is a ceiling to enforce, not a number to
  // trust. Cycles are legal (no cycle detection), so an unbounded value walks
  // forever with no model in the loop; NaN is worse, because `depth + 1 > NaN`
  // is always false and the bound never fires at all.
  const maxDepth = Number.isFinite(plan.maxDepth)
    ? Math.max(0, Math.min(plan.maxDepth as number, DEFAULT_MAX_DEPTH))
    : DEFAULT_MAX_DEPTH;
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

    // Host-policy hard-stop: check every operation before running any item in
    // this node. A static checker cannot prompt mid-walk, so it stops on a
    // deny/ask match; a host with a live permission bridge (opencode's
    // `context.ask`) may prompt inside the check and stop only on refusal.
    const checkOperationPolicy: OperationPolicyChecker | undefined = opts.checkOperationPolicy;
    if (checkOperationPolicy) {
      const violation = await findPolicyViolation(current, checkOperationPolicy, opts.cwd, effectiveCwd, opts.signal);
      if (violation === "aborted") {
        return result(pathTaken, depth, "aborted", blocks.join("\n\n"), edgesEvaluated, edgesMatched);
      }
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
      const { result: matched, detail } = evaluateConditionWithDetail(output, edge.when, effectiveCwd, opts.cwd);
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

export function resolvePlanCwd(sessionRoot: string, planCwd?: string): { cwd: string } | { error: string } {
  if (planCwd === undefined) return { cwd: sessionRoot };
  if (typeof planCwd !== "string" || planCwd === "" || isAbsolute(planCwd)) {
    return { error: "cwd must be a relative directory inside the session root" };
  }
  const cwd = resolve(sessionRoot, planCwd);
  if (!isInsideRoot(sessionRoot, cwd)) {
    return { error: "cwd must be a relative directory inside the session root" };
  }
  return { cwd };
}

/**
 * Pure structural + tier validation. Returns an error string, or null if valid.
 * Tier rule: a LOW-confidence edge (`match`) may not point at a mutating node —
 * only cleanly-separable predicates may gate a mutating child.
 */
export function validatePlan(plan: PlanTree, byId: Map<string, PlanNode>): string | null {
  if (!Array.isArray(plan?.nodes) || plan.nodes.length === 0) return "no nodes";
  if (plan.nodes.length > MAX_PLAN_NODES) return `plan exceeds the maximum of ${MAX_PLAN_NODES} nodes`;
  if (typeof plan.root !== "string" || plan.root.length === 0 || plan.root.length > MAX_NODE_ID_LENGTH) {
    return `root must be a non-empty id of at most ${MAX_NODE_ID_LENGTH} characters`;
  }

  // Shape checks come first. The plan is model-authored, so a malformed node is
  // an ordinary occurrence, not an exceptional one — and every one of these used
  // to escape runPlanTree as a raw TypeError instead of a `stoppedReason:"error"`
  // result the adapters could render.
  for (const node of plan.nodes) {
    if (!node || typeof node !== "object") return "every node must be an object";
    if (typeof node.id !== "string" || node.id === "" || node.id.length > MAX_NODE_ID_LENGTH) {
      return `every node needs a non-empty string id of at most ${MAX_NODE_ID_LENGTH} characters`;
    }
    if (!Array.isArray(node.commands)) return `node "${node.id}" needs a commands array`;
    if (node.commands.length > MAX_OPERATIONS_PER_NODE) {
      return `node "${node.id}" exceeds the maximum of ${MAX_OPERATIONS_PER_NODE} operations per node`;
    }
    if (node.edges !== undefined && !Array.isArray(node.edges)) return `node "${node.id}" edges must be an array`;
    for (let index = 0; index < node.commands.length; index++) {
      const command = node.commands[index];
      if (typeof command === "string" && command.length > MAX_COMMAND_LENGTH) {
        return `node "${node.id}" command ${index + 1} exceeds the maximum length of ${MAX_COMMAND_LENGTH} characters`;
      }
      const operationError = validateOperation(node.commands[index]);
      if (operationError) return `node "${node.id}" operation ${index + 1} invalid: ${operationError}`;
    }
    if (byId.has(node.id)) return `duplicate node id "${node.id}"`;
    byId.set(node.id, node);
  }
  const edgeCount = plan.nodes.reduce((count, node) => count + (node.edges?.length ?? 0), 0);
  if (edgeCount > MAX_PLAN_EDGES) return `plan exceeds the maximum of ${MAX_PLAN_EDGES} edges`;
  if (!byId.has(plan.root)) return `root "${plan.root}" is not a node`;

  let conditionTotal = 0;
  for (const node of plan.nodes) {
    for (const edge of node.edges ?? []) {
      if (!edge || typeof edge !== "object") return `node "${node.id}" has a malformed edge`;
      if (typeof edge.to !== "string") return `edge from "${node.id}" needs a string target`;
      if (!edge.when || typeof edge.when !== "object" || typeof edge.when.kind !== "string") {
        return `edge from "${node.id}" to "${edge.to}" has no condition kind`;
      }
      const budget = conditionStringBudget(edge.when, edge.to, conditionTotal);
      if (budget.error) return budget.error;
      conditionTotal = budget.total;
      const target = byId.get(edge.to);
      if (!target) return `edge from "${node.id}" points at missing node "${edge.to}"`;
      if (edge.when.kind === "jsonPath" && node.commands.length !== 1) {
        return JSON_PATH_SINGLE_OP_MESSAGE;
      }
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
 * Host-policy check over a node's operations (shell strings, `{tool:"bash"}`
 * ops, and native tool ops). Runs the adapter-provided checker, awaiting an
 * async one; a hit means the HOST would deny or prompt for this command —
 * predexec cannot prompt mid-walk, so it hard-stops before running, same
 * contract as the mutation stop. Every operation is checked even after a hit.
 * A shell command is also checked as each of its `policyShellVariants`. A
 * checker that throws or rejects is a hit (fail closed); an abort between
 * checks returns "aborted".
 */
async function findPolicyViolation(
  node: PlanNode,
  check: OperationPolicyChecker,
  sessionRoot: string,
  effectiveCwd: string,
  signal: AbortSignal | undefined,
): Promise<PolicyViolation | "aborted" | null> {
  const base: PolicyCheckContext = { cwd: effectiveCwd, sessionRoot, ...(signal ? { signal } : {}) };
  let violation: PolicyViolation | null = null;
  for (let i = 0; i < node.commands.length; i++) {
    const op = node.commands[i]!;
    const command = isToolOp(op) ? formatToolOpLabel(op) : op;
    let rule: string | HostPolicyDenial | null = null;
    try {
      const shell = typeof op === "string" ? op : op.tool === "bash" && typeof op.command === "string" ? op.command : null;
      const checked: Operation[] = [normalizePolicyOperation(op, sessionRoot, effectiveCwd)];
      if (shell !== null) checked.push(...policyShellVariants(shell));
      for (let v = 0; v < checked.length; v++) {
        const operation = checked[v]!;
        if (signal?.aborted) return "aborted";
        const context: PolicyCheckContext = { ...base, operationIndex: i, ...(v > 0 ? { variant: true } : {}) };
        const verdict = await raceAbort(check(operation, context), signal);
        if (verdict === "aborted") return "aborted";
        // One verdict decides this operation; further variants would only add
        // host prompts. Later operations are still checked.
        if (verdict) {
          rule = verdict;
          break;
        }
      }
    } catch (err) {
      rule = `policy check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (rule && !violation) violation = { index: i, command, rule };
  }
  return violation;
}

/** Settle a (possibly async) verdict, or "aborted" as soon as `signal` fires. */
function raceAbort(verdict: PolicyVerdict | Promise<PolicyVerdict>, signal: AbortSignal | undefined): Promise<PolicyVerdict | "aborted"> {
  if (!signal) return Promise.resolve(verdict);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve("aborted");
    if (signal.aborted) {
      // The abandoned check may still reject; that is not this walk's error.
      Promise.resolve(verdict).catch(() => {});
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(verdict).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Nesting bound for `sh -c "bash -c '...'"` expansion in policyShellVariants.
 * A termination bound, never an allow: a payload nested deeper throws, and the
 * caller turns the throw into a policyStop.
 */
const MAX_POLICY_SHELL_DEPTH = 8;

/**
 * The extra spellings of one shell command a host policy must also see, so a
 * rule on `cat .env` cannot be sidestepped by wrapping it: every inner clause
 * of a `sh|bash|zsh|dash -c '<script>'` (recursively, including one that sits
 * inside a `$(…)`, backtick or `<(…)` substitution), and every clause's
 * decoded argv form — quotes/escapes removed, leading assignments, `env` and
 * wrappers dropped, head reduced to its basename (`/usr/bin/env '/bin/cat'
 * .env` → `cat .env`). The command itself is not included, and nothing is
 * returned for a command with neither form. Throws (fail closed) when the
 * substitution tree cannot be fully inspected, the shell nesting exceeds
 * MAX_POLICY_SHELL_DEPTH, or a clause's command name is an expansion.
 */
export function policyShellVariants(command: string): string[] {
  const variants: string[] = [];
  const seen = new Set<string>([command.trim()]);
  const add = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      variants.push(trimmed);
    }
  };
  const expanded = new Set<string>();
  const visit = (text: string, depth: number): void => {
    // The text itself, then every substitution/compound body under it.
    const tree = inspectCommandSubstitutionTree(text);
    if (!tree.complete) throw new Error("command substitutions too deep or large to inspect for policy");
    for (const body of tree.commands) {
      for (const piece of splitCommandSegments(body)) {
        for (const clause of new Set([piece, ...extractShellCommandClauses(piece)])) {
          // No host rule can match a program chosen at run time (`$c .env`).
          if (hasDynamicCommandName(clause)) {
            throw new Error("unresolvable command name (an expansion in the command position)");
          }
          const argvForm = decodedArgvForm(clause);
          if (argvForm !== null) add(argvForm);
          const shell = shellEvalPayload(clause);
          if (shell?.payload == null) continue;
          if (depth >= MAX_POLICY_SHELL_DEPTH) {
            throw new Error(`shell nesting deeper than ${MAX_POLICY_SHELL_DEPTH} levels cannot be inspected for policy`);
          }
          for (const inner of splitCommandSegments(shell.payload)) {
            // A clause can surface both as a tree body and as a clause of its
            // parent; expanding it once keeps the walk linear.
            if (expanded.has(inner)) continue;
            expanded.add(inner);
            add(inner);
            visit(inner, depth + 1);
          }
        }
      }
    }
  };
  visit(command, 0);
  return variants;
}

/** Quote an argv word for a host policy's shell-text matcher. */
function quotePolicyWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./{}-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The clause as its effective command, `head args` with the head's basename,
 * when that differs from how it is spelled (an absolute, quoted or escaped
 * head, or leading assignments/`env`/wrappers); null otherwise.
 */
function decodedArgvForm(clause: string): string | null {
  const trimmed = clause.trim();
  const normalized = normalizeEnvInvocation(tokenizeShellWords(trimmed, ARGV));
  if (!normalized.complete || normalized.argv.length === 0) return null;
  const head = normalized.argv[0]!;
  const base = head.replace(/^.*\//, "");
  if (!base) return null;
  if (head === base && trimmed.split(/\s/, 1)[0] === base) return null;
  return [base, ...normalized.argv.slice(1)].map(quotePolicyWord).join(" ");
}

/** Map native relative targets to the session-root namespace used by hosts. */
function normalizePolicyOperation(operation: Operation, sessionRoot: string, effectiveCwd: string): Operation {
  if (typeof operation === "string" || operation.tool === "bash") return operation;
  const withPrefix = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const candidate = resolve(effectiveCwd, value);
    const rel = relative(sessionRoot, candidate);
    const inside = isInsideRoot(sessionRoot, candidate);
    // Preserve escaping targets outside the root. The executor remains the
    // authority that rejects them; normalization must not create an allowed
    // in-root spelling for an invalid operation.
    return inside ? rel.replaceAll(sep, "/") || "." : candidate.replaceAll(sep, "/");
  };
  const normalized: ToolOp = { ...operation };
  if ("path" in operation) normalized.path = withPrefix(operation.path);
  return normalized;
}

function transcriptBlock(node: PlanNode, output: NodeOutput): string {
  const lines = [`## node ${node.id} (exit ${output.exitCode})`];
  const toolOps = node.commands.filter(isToolOp);
  if (toolOps.length > 0) {
    lines.push(toolOps.map((op) => `[${formatToolOpLabel(op)}]`).join(" "));
  }
  if (output.stdout) lines.push("stdout:", output.stdout.trimEnd());
  if (output.stderr) lines.push("stderr:", output.stderr.trimEnd());
  if (output.stdoutTruncated || output.stderrTruncated) {
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

interface PolicyViolation {
  index: number;
  command: string;
  rule: string | HostPolicyDenial;
}

function policyBlock(node: PlanNode, violation: PolicyViolation): string {
  const native = violation.command.startsWith("read:") || violation.command.startsWith("grep:") ||
    violation.command.startsWith("find:") || violation.command.startsWith("ls:");
  const why = typeof violation.rule === "string"
    ? `Blocked by host permission rule '${violation.rule}'`
    : `Blocked — ${violation.rule.hostDenied} —`;
  return [
    `## node ${node.id} — POLICY HARD-STOP (not run)`,
    `${why} on operation ${violation.index + 1}: ${violation.command}`,
    native
      ? "Use the host's native file/search tool instead — it enforces/prompts per the host's permission config."
      : "Run this via the host bash tool instead — it enforces/prompts per the host's permission config.",
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
