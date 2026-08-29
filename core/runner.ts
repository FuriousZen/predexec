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

/** Marker prefix for truncated output; engine.ts checks for `${TRUNCATION_MARKER}]`. */
export const TRUNCATION_MARKER = "…[truncated" as const;

interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export function isToolOp(op: Operation): op is ToolOp {
  return typeof op === "object" && op !== null && typeof op.tool === "string";
}

export async function runNode(node: PlanNode, opts: RunOptions): Promise<NodeOutput> {
  if (node.commands.length === 0) {
    return { stdout: "", stderr: "", exitCode: 0, stdoutTruncated: false, stderrTruncated: false };
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
  return {
    command: "unknown",
    stdout: "",
    stderr: "invalid operation: expected string or {tool, ...}",
    exitCode: 1,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

async function runToolOp(op: ToolOp, opts: RunOptions): Promise<CommandResult> {
  const label = formatToolOpLabel(op);
  if (!opts.executeToolOp) {
    return {
      command: label,
      stdout: "",
      stderr: "no tool executor provided for tool operations",
      exitCode: 1,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
  try {
    const result = await opts.executeToolOp(op, { cwd: opts.cwd, signal: opts.signal });
    const stdoutTruncated = result.stdout.length > OUTPUT_CAP;
    const stderrTruncated = result.stderr.length > OUTPUT_CAP;
    const stdout = stdoutTruncated ? `${result.stdout.slice(0, OUTPUT_CAP)}\n${TRUNCATION_MARKER}]` : result.stdout;
    const stderr = stderrTruncated ? `${result.stderr.slice(0, OUTPUT_CAP)}\n${TRUNCATION_MARKER}]` : result.stderr;
    if (stdout) opts.onCommandOutput?.(stdout);
    if (stderr) opts.onCommandOutput?.(stderr);
    return { command: label, stdout, stderr, exitCode: result.exitCode, stdoutTruncated, stderrTruncated };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { command: label, stdout: "", stderr: msg, exitCode: 1, stdoutTruncated: false, stderrTruncated: false };
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
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      signal: opts.signal,
    });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        command,
        stdout: stdoutTruncated ? `${stdout}\n${TRUNCATION_MARKER}]` : stdout,
        stderr: stderrTruncated ? `${stderr}\n${TRUNCATION_MARKER}]` : stderr,
        exitCode,
        stdoutTruncated,
        stderrTruncated,
      });
    };

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      const remaining = OUTPUT_CAP - stdout.length;
      if (remaining > 0) stdout += s.slice(0, remaining);
      if (s.length > remaining) stdoutTruncated = true;
      opts.onCommandOutput?.(s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      const remaining = OUTPUT_CAP - stderr.length;
      if (remaining > 0) stderr += s.slice(0, remaining);
      if (s.length > remaining) stderrTruncated = true;
      opts.onCommandOutput?.(s);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // Spawn failure or abort kill. Surface as a non-zero exit so edges can react.
      const message = `${err.message}\n`;
      const remaining = OUTPUT_CAP - stderr.length;
      if (remaining > 0) stderr += message.slice(0, remaining);
      if (message.length > remaining) stderrTruncated = true;
      finish(typeof err.errno === "number" ? err.errno : 1);
    });

    child.on("close", (code, sig) => {
      finish(code ?? (sig ? 1 : 0));
    });
  });
}

function aggregate(results: CommandResult[]): NodeOutput {
  const joinedStdout = joinLabeled(results, (r) => r.stdout);
  const joinedStderr = joinLabeled(results, (r) => r.stderr);
  const cappedStdout = cap(joinedStdout.text);
  const cappedStderr = cap(joinedStderr.text);
  // exitCode = the failing command's code (stop-on-first-error left it last) or the last command's.
  const failed = results.find((r) => r.exitCode !== 0);
  const last = results[results.length - 1];
  const exitCode = failed ? failed.exitCode : (last?.exitCode ?? 0);
  // joinLabeled already budgets per command; the outer cap is a final backstop
  // for the (rare) case where the per-command floor sums above OUTPUT_CAP.
  return {
    stdout: cappedStdout.text,
    stderr: cappedStderr.text,
    exitCode,
    stdoutTruncated: joinedStdout.truncated || cappedStdout.truncated || results.some((r) => r.stdoutTruncated),
    stderrTruncated: joinedStderr.truncated || cappedStderr.truncated || results.some((r) => r.stderrTruncated),
  };
}

/**
 * Join per-command output under index labels, giving each command its own slice
 * of OUTPUT_CAP.
 *
 * Capping the *joined* string instead let one verbose early command consume the
 * whole budget and silently delete every later command's output — they ran,
 * they succeeded, and they vanished, while exitCode stayed 0 and edges branched
 * on a batch that had lost most of its content. Silent truncation is a false-hit
 * generator, which is the one failure mode the design cannot absorb: a miss
 * costs ~0 requests, a wrong branch costs real ones.
 *
 * Per-command budgets keep every command represented, and an explicit marker
 * tells the model which ones were shortened rather than leaving it to infer.
 */
function joinLabeled(results: CommandResult[], pick: (r: CommandResult) => string): { text: string; truncated: boolean } {
  if (results.length === 1) return { text: cap(pick(results[0]!)).text, truncated: false };

  const budget = Math.max(256, Math.floor(OUTPUT_CAP / results.length));
  let truncated = false;
  const text = results
    .map((r, i) => {
      const text = pick(r);
      if (!text) return "";
      // Index label, not the full command: the command is already in the plan
      // (tool-call args), so echoing it back double-counts it in context.
      const capped = cap(text, budget);
      truncated ||= capped.truncated;
      return `[${i + 1}]\n${capped.text}`;
    })
    .filter(Boolean)
    .join("\n");
  return { text, truncated };
}

function cap(text: string, limit = OUTPUT_CAP): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n${TRUNCATION_MARKER}: ${text.length - limit} more chars]`,
    truncated: true,
  };
}
