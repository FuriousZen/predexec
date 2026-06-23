/**
 * predexec core — batch runner.
 *
 * Runs one PlanNode's command batch and aggregates it into a single NodeOutput.
 * Sequential by default with STOP-ON-FIRST-ERROR; concurrent when `parallel`.
 * Output is captured and truncated for the model-readable transcript.
 */

import { spawn } from "node:child_process";
import type { NodeOutput, Operation, PlanNode, RunOptions, ToolOp } from "./types.ts";

/** Per-stream capture cap (chars). Keeps the transcript bounded on noisy commands. */
export const OUTPUT_CAP = 8192;

interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function isToolOp(op: Operation): op is ToolOp {
  return typeof op === "object" && op !== null && typeof op.tool === "string";
}

export async function runNode(node: PlanNode, opts: RunOptions): Promise<NodeOutput> {
  if (node.commands.length === 0) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  const results: CommandResult[] = node.parallel
    ? await runParallel(node.commands, opts)
    : await runSequential(node.commands, opts);

  return aggregate(results);
}

async function runSequential(commands: Operation[], opts: RunOptions): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const command of commands) {
    if (opts.signal?.aborted) break;
    const res = await runOneOp(command, opts);
    results.push(res);
    if (res.exitCode !== 0) break;
  }
  return results;
}

async function runParallel(commands: Operation[], opts: RunOptions): Promise<CommandResult[]> {
  return Promise.all(commands.map((command) => runOneOp(command, opts)));
}

async function runOneOp(op: Operation, opts: RunOptions): Promise<CommandResult> {
  if (typeof op === "string") return runShell(op, opts);
  if (isToolOp(op)) return runToolOp(op, opts);
  return { command: "unknown", stdout: "", stderr: "invalid operation: expected string or {tool, ...}", exitCode: 1 };
}

async function runToolOp(op: ToolOp, opts: RunOptions): Promise<CommandResult> {
  const label = formatToolOpLabel(op);
  if (!opts.executeToolOp) {
    return { command: label, stdout: "", stderr: "no tool executor provided for tool operations", exitCode: 1 };
  }
  try {
    const result = await opts.executeToolOp(op, { cwd: opts.cwd, signal: opts.signal });
    if (result.stdout) opts.onCommandOutput?.(result.stdout);
    if (result.stderr) opts.onCommandOutput?.(result.stderr);
    return { command: label, ...result };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { command: label, stdout: "", stderr: msg, exitCode: 1 };
  }
}

/** Produce a short label like `read:src/foo.ts` or `grep:pattern` for transcript headers. */
export function formatToolOpLabel(op: ToolOp): string {
  const primary = (op.path ?? op.pattern ?? op.command ?? "") as string;
  return primary ? `${op.tool}:${primary}` : op.tool;
}

function runShell(command: string, opts: RunOptions): Promise<CommandResult> {
  return new Promise<CommandResult>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      signal: opts.signal,
    });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolvePromise({ command, stdout, stderr, exitCode });
    };

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      if (stdout.length < OUTPUT_CAP) stdout += s;
      opts.onCommandOutput?.(s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      if (stderr.length < OUTPUT_CAP) stderr += s;
      opts.onCommandOutput?.(s);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // Spawn failure or abort kill. Surface as a non-zero exit so edges can react.
      if (stderr.length < OUTPUT_CAP) stderr += `${err.message}\n`;
      finish(typeof err.errno === "number" ? err.errno : 1);
    });

    child.on("close", (code, sig) => {
      finish(code ?? (sig ? 1 : 0));
    });
  });
}

function aggregate(results: CommandResult[]): NodeOutput {
  const stdout = joinLabeled(results, (r) => r.stdout);
  const stderr = joinLabeled(results, (r) => r.stderr);
  // exitCode = the failing command's code (stop-on-first-error left it last) or the last command's.
  const failed = results.find((r) => r.exitCode !== 0);
  const last = results[results.length - 1];
  const exitCode = failed ? failed.exitCode : (last?.exitCode ?? 0);
  return { stdout: cap(stdout), stderr: cap(stderr), exitCode };
}

function joinLabeled(results: CommandResult[], pick: (r: CommandResult) => string): string {
  if (results.length === 1) return pick(results[0]!);
  return results
    .map((r, i) => {
      const text = pick(r);
      // Index label, not the full command: the command is already in the plan
      // (tool-call args), so echoing it back double-counts it in context.
      return text ? `[${i + 1}]\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function cap(text: string): string {
  if (text.length <= OUTPUT_CAP) return text;
  return `${text.slice(0, OUTPUT_CAP)}\n…[truncated]`;
}
