/**
 * predexec core — batch runner.
 *
 * Runs one PlanNode's command batch and aggregates it into a single NodeOutput.
 * Sequential by default with STOP-ON-FIRST-ERROR; concurrent when `parallel`.
 * Output is captured and truncated for the model-readable transcript.
 */

import { spawn } from "node:child_process";
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, MAX_PARALLEL_CONCURRENCY } from "./types.ts";
import type { NodeOutput, Operation, PlanNode, RunOptions, ToolOp } from "./types.ts";

/** Per-stream capture cap (chars). Keeps the transcript bounded on noisy commands. */
export const OUTPUT_CAP = 8192;

/**
 * Marker prefix for truncated output. Rendered as `${TRUNCATION_MARKER}]` (count
 * unknown) or `${TRUNCATION_MARKER}: N more chars]`; conditions.ts strips both
 * forms before matching, and the pi adapter renders its own.
 */
export const TRUNCATION_MARKER = "…[truncated" as const;

/** GNU `timeout` convention for a command killed for exceeding its time bound. */
const TIMEOUT_EXIT_CODE = 124;

/** How long to wait for pipes to close after killing a timed-out group before giving up on them. */
const KILL_GRACE_MS = 2_000;

/**
 * One command's captured output. `stdout`/`stderr` hold the KEPT text with no
 * marker; the marker is rendered once, by `cap()`, from `*Total` (every char the
 * command produced), so the reported dropped count is the true one rather than
 * a count of an already-marked, already-capped string.
 */
interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  stdoutTotal: number;
  stderrTotal: number;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** A result paired with its command's position in the node, so labels survive gaps. */
interface IndexedResult {
  index: number;
  result: CommandResult;
}

function failedResult(command: string, stderr: string): CommandResult {
  return {
    command,
    stdout: "",
    stderr,
    stdoutTotal: 0,
    stderrTotal: stderr.length,
    exitCode: 1,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

export function isToolOp(op: Operation): op is ToolOp {
  return typeof op === "object" && op !== null && typeof op.tool === "string";
}

export async function runNode(node: PlanNode, opts: RunOptions): Promise<NodeOutput> {
  if (node.commands.length === 0) {
    return { stdout: "", stderr: "", exitCode: 0, stdoutTruncated: false, stderrTruncated: false };
  }

  const results: IndexedResult[] = node.parallel
    ? await runParallel(node.commands, opts)
    : await runSequential(node.commands, opts);

  return aggregate(results);
}

async function runSequential(commands: Operation[], opts: RunOptions): Promise<IndexedResult[]> {
  const results: IndexedResult[] = [];
  for (const [index, command] of commands.entries()) {
    if (opts.signal?.aborted) break;
    const result = await runOneOp(command, opts);
    results.push({ index, result });
    if (result.exitCode !== 0) break;
  }
  return results;
}

async function runParallel(commands: Operation[], opts: RunOptions): Promise<IndexedResult[]> {
  const results = new Array<CommandResult | undefined>(commands.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (!opts.signal?.aborted && next < commands.length) {
      const index = next++;
      results[index] = await runOneOp(commands[index]!, opts);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_CONCURRENCY, commands.length) }, () => worker()),
  );
  // Keep each command's original index: filtering unstarted slots out of a bare
  // array would renumber every later `[i]` label onto the wrong command.
  const indexed: IndexedResult[] = [];
  results.forEach((result, index) => {
    if (result) indexed.push({ index, result });
  });
  return indexed;
}

async function runOneOp(op: Operation, opts: RunOptions): Promise<CommandResult> {
  if (typeof op === "string") return runShell(op, opts);
  if (isToolOp(op)) return runToolOp(op, opts);
  return failedResult("unknown", "invalid operation: expected string or {tool, ...}");
}

async function runToolOp(op: ToolOp, opts: RunOptions): Promise<CommandResult> {
  const label = formatToolOpLabel(op);
  if (!opts.executeToolOp) {
    return failedResult(label, "no tool executor provided for tool operations");
  }
  try {
    const result = await opts.executeToolOp(op, { cwd: opts.cwd, signal: opts.signal });
    const stdoutTruncated = result.stdoutTruncated === true || result.stdout.length > OUTPUT_CAP;
    const stderrTruncated = result.stderrTruncated === true || result.stderr.length > OUTPUT_CAP;
    const res: CommandResult = {
      command: label,
      stdout: result.stdout.slice(0, OUTPUT_CAP),
      stderr: result.stderr.slice(0, OUTPUT_CAP),
      stdoutTotal: result.stdout.length,
      stderrTotal: result.stderr.length,
      exitCode: result.exitCode,
      stdoutTruncated,
      stderrTruncated,
    };
    const stdout = render(res, "stdout", OUTPUT_CAP).text;
    const stderr = render(res, "stderr", OUTPUT_CAP).text;
    if (stdout) opts.onCommandOutput?.(stdout);
    if (stderr) opts.onCommandOutput?.(stderr);
    return res;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return failedResult(label, msg);
  }
}

/** Produce a short label like `read:src/foo.ts` or `grep:pattern` for transcript headers. */
export function formatToolOpLabel(op: ToolOp): string {
  const primary = (op.path ?? op.pattern ?? op.command ?? "") as string;
  return primary ? `${op.tool}:${primary}` : op.tool;
}

function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== "number" || Number.isNaN(ms)) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1_000, ms));
}

/**
 * Run one shell command with a closed stdin, a wall-clock bound, and abort
 * support. The child leads its own process group (`detached`), so a timeout or
 * abort SIGKILLs the whole group — `sh -c 'sleep 30 & sleep 30'` would otherwise
 * leave the backgrounded child holding the pipes open and the promise pending.
 */
function runShell(command: string, opts: RunOptions): Promise<CommandResult> {
  return new Promise<CommandResult>((resolvePromise) => {
    const timeoutMs = clampTimeout(opts.commandTimeoutMs);
    let stdout = "";
    let stderr = "";
    let stdoutTotal = 0;
    let stderrTotal = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const appendStderr = (s: string) => {
      stderrTotal += s.length;
      const remaining = OUTPUT_CAP - stderr.length;
      if (remaining > 0) stderr += s.slice(0, remaining);
    };

    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The group may already be gone.
      }
      // A process that escaped the group (setsid) can still hold the pipes open;
      // stop waiting on them after a grace period rather than hanging the walk.
      graceTimer ??= setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(1);
      }, KILL_GRACE_MS);
      graceTimer.unref?.();
    };

    const onAbort = () => {
      aborted = true;
      killGroup();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (timedOut) {
        appendStderr(`${stderr && !stderr.endsWith("\n") ? "\n" : ""}[predexec] command timed out after ${timeoutMs}ms\n`);
        exitCode = TIMEOUT_EXIT_CODE;
      } else if (aborted) {
        appendStderr(`${stderr && !stderr.endsWith("\n") ? "\n" : ""}[predexec] command aborted\n`);
        if (exitCode === 0) exitCode = 1;
      }
      resolvePromise({
        command,
        stdout,
        stderr,
        stdoutTotal,
        stderrTotal,
        exitCode,
        stdoutTruncated: stdoutTotal > OUTPUT_CAP,
        stderrTruncated: stderrTotal > OUTPUT_CAP,
      });
    };

    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    // setEncoding keeps a multi-byte UTF-8 character split across two chunks intact.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (s: string) => {
      stdoutTotal += s.length;
      const remaining = OUTPUT_CAP - stdout.length;
      if (remaining > 0) stdout += s.slice(0, remaining);
      opts.onCommandOutput?.(s);
    });
    child.stderr?.on("data", (s: string) => {
      appendStderr(s);
      opts.onCommandOutput?.(s);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // Spawn failure. Surface as a non-zero exit so edges can react.
      appendStderr(`${err.message}\n`);
      finish(typeof err.errno === "number" ? err.errno : 1);
    });

    child.on("close", (code, sig) => {
      finish(code ?? (sig ? 1 : 0));
    });
  });
}

function aggregate(results: IndexedResult[]): NodeOutput {
  const stdout = joinLabeled(results, "stdout");
  const stderr = joinLabeled(results, "stderr");
  // exitCode = the failing command's code (stop-on-first-error left it last) or the last command's.
  const failed = results.find(({ result }) => result.exitCode !== 0);
  const last = results[results.length - 1];
  const exitCode = failed ? failed.result.exitCode : (last?.result.exitCode ?? 0);
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode,
    stdoutTruncated: stdout.truncated || results.some(({ result }) => result.stdoutTruncated),
    stderrTruncated: stderr.truncated || results.some(({ result }) => result.stderrTruncated),
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
function joinLabeled(results: IndexedResult[], stream: Stream): { text: string; truncated: boolean } {
  if (results.length === 1) return render(results[0]!.result, stream, OUTPUT_CAP);

  const budget = Math.max(256, Math.floor(OUTPUT_CAP / results.length));
  let truncated = false;
  const text = results
    .map(({ index, result }) => {
      if (!result[stream]) return "";
      // Index label, not the full command: the command is already in the plan
      // (tool-call args), so echoing it back double-counts it in context.
      const capped = render(result, stream, budget);
      truncated ||= capped.truncated;
      return `[${index + 1}]\n${capped.text}`;
    })
    .filter(Boolean)
    .join("\n");
  // Final backstop for the (rare) case where the per-command floor sums above
  // OUTPUT_CAP. Applied only then: re-capping an already-marked join would
  // clip the last command's marker and misreport its dropped count.
  if (budget * results.length > OUTPUT_CAP) {
    const backstop = cap(text);
    return { text: backstop.text, truncated: truncated || backstop.truncated };
  }
  return { text, truncated };
}

type Stream = "stdout" | "stderr";

/**
 * Render one command's stream under `limit`, marking it once. The dropped count
 * comes from the command's true total, not from the kept text. A result the
 * adapter itself truncated with no known total gets the count-less marker.
 */
function render(r: CommandResult, stream: Stream, limit: number): { text: string; truncated: boolean } {
  const text = r[stream];
  const total = stream === "stdout" ? r.stdoutTotal : r.stderrTotal;
  const flagged = stream === "stdout" ? r.stdoutTruncated : r.stderrTruncated;
  if (total > limit || text.length > limit) return cap(text, limit, total);
  if (flagged) return { text: `${text}\n${TRUNCATION_MARKER}]`, truncated: true };
  return { text, truncated: false };
}

function cap(text: string, limit = OUTPUT_CAP, originalLength = text.length): { text: string; truncated: boolean } {
  const total = Math.max(originalLength, text.length);
  if (total <= limit) return { text, truncated: false };
  const kept = text.slice(0, limit);
  return {
    text: `${kept}\n${TRUNCATION_MARKER}: ${total - kept.length} more chars]`,
    truncated: true,
  };
}
