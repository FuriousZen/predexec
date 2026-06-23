/**
 * predexec core — batch runner.
 *
 * Runs one PlanNode's command batch and aggregates it into a single NodeOutput.
 * Sequential by default with STOP-ON-FIRST-ERROR; concurrent when `parallel`.
 * Output is captured and truncated for the model-readable transcript.
 */

import { spawn } from "node:child_process";
import type { NodeOutput, PlanNode, RunOptions } from "./types.ts";

/** Per-stream capture cap (chars). Keeps the transcript bounded on noisy commands. */
export const OUTPUT_CAP = 8192;

interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
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

async function runSequential(commands: string[], opts: RunOptions): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const command of commands) {
    if (opts.signal?.aborted) break;
    const res = await runOne(command, opts);
    results.push(res);
    // Stop-on-first-error: a non-zero exit halts the sequential batch.
    if (res.exitCode !== 0) break;
  }
  return results;
}

async function runParallel(commands: string[], opts: RunOptions): Promise<CommandResult[]> {
  return Promise.all(commands.map((command) => runOne(command, opts)));
}

function runOne(command: string, opts: RunOptions): Promise<CommandResult> {
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
