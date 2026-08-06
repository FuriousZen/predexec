/**
 * predexec — Claude Code (MCP) adapter: read-only tool ops.
 *
 * pi borrows the host's own tool factories and opencode calls the host's SDK.
 * An MCP server is a separate process with neither, so read/grep/find/ls are
 * implemented here over node:fs. `rg`/`fd` are used ONLY as accelerators when
 * they are on PATH: every result is relativized, matched, sorted and capped by
 * THIS file, so the two paths differ in which files they visit — never in how
 * the output is shaped. `read` never shells out at all; routing file reads back
 * through a shell would re-enter the command path that policy exists to gate.
 *
 * grep/find exit codes follow grep(1)/rg: 0 = results, 1 = no results (a fact,
 * not a failure), 2 = the search never happened (bad pattern, missing path, dead
 * binary, abort). read/ls keep the siblings' plain 0/1 — they have no no-results
 * state to confuse. The 2 is a deliberate divergence from the pi and opencode
 * adapters, which report 1 for everything: those run inside a host that mediates
 * failures, while here a typo'd path would otherwise branch down an `exit == 1`
 * "nothing matched" edge on a search that never ran. It errs toward a miss (~0
 * requests) over a false-hit (real requests to unwind).
 *
 * Known parity gaps vs pi's native tools — documented, not hidden:
 *  - the pure-Node fallback does not honor .gitignore (rg/fd do), so it can
 *    return MORE files; the ops say so on stderr whenever they fall back,
 *    because a silently different file set feeds silently different edges.
 *  - grep patterns run through Rust's regex engine under rg and JS's RegExp in
 *    the fallback; lookaround works only in the fallback.
 *  - binaries/images are refused rather than attached — an MCP text result
 *    cannot carry an image, and raw bytes would poison every regex condition.
 */

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ToolExecutor, ToolOp } from "../core/index.ts";

/** The shell-like shape the core engine branches on (see core/runner.ts). */
interface OpResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Result caps. Sourced from the siblings so a plan behaves the same on all three
 * harnesses: grep/ls/read from pi's native tools, find from the opencode adapter.
 */
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 100;
const DEFAULT_LS_LIMIT = 500;
const DEFAULT_READ_LINES = 2000;

/** Ceiling on the pure-Node walk. An unbounded walk on a huge tree reads as a hang. */
const MAX_WALK_FILES = 20_000;

/**
 * execFile's default maxBuffer is 1MB, and overflow kills the child — which
 * surfaces as an error that looks exactly like "no matches". Raise it, and
 * report an overflow loudly if it still happens.
 */
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Never visited. This is also the only lever the pure-Node walk has for
 * approximating rg/fd's .gitignore awareness, so both paths exclude these to
 * keep the accelerated and fallback file sets as close as they can be.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

/**
 * Emitted on every fallback search. Divergence must be as loud as truncation:
 * the same plan returning a different file set on a machine without ripgrep is
 * a false-hit sourced from the host's installed tooling, and the model has no
 * other way to know which walk produced its numbers.
 */
const NO_GITIGNORE_NOTE =
  "unavailable; using the pure-Node walk, which does not honor .gitignore — results may include ignored files";

const walkCapNote = (label: string): string =>
  `${label}: stopped after visiting ${MAX_WALK_FILES} files — results are incomplete; scope the search with \`path\``;

const execFileAsync = promisify(execFile);

export interface ToolExecutorOptions {
  /** Session root. Ops resolve relative paths beneath it and may not escape it. */
  cwd: string;
  /**
   * Accelerator binaries. `undefined` looks the binary up on PATH; an explicit
   * `null` pins the pure-Node path (which is how the fallback is tested); a
   * string uses that binary as-is.
   */
  rgPath?: string | null;
  fdPath?: string | null;
}

/**
 * Exit status for "we could not look", chosen per tool.
 *
 * grep/find reserve 1 for "searched, found nothing", so every failure that
 * PREVENTED a search — a typo'd path, a dead accelerator, a broken pattern, an
 * abort — must land somewhere else, or it branches down the no-matches edge
 * claiming a fact it never established. read/ls have no no-results state, so 1
 * stays their single failure code.
 */
const SEARCH_ERROR_EXIT = 2;
const errorExit = (tool: string): number => (tool === "grep" || tool === "find" ? SEARCH_ERROR_EXIT : 1);

const fail = (label: string, msg: string, exitCode = errorExit(label)): OpResult => ({
  stdout: "",
  stderr: `${label}: ${msg}`,
  exitCode,
});

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const positiveInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

/** Paths go to the model in posix form regardless of host, so a plan reads the same everywhere. */
const toPosix = (p: string): string => p.split(sep).join("/");

/** Path as the model should quote it back: relative to the op's cwd, absolute only if it sits outside. */
function relativize(base: string, abs: string): string {
  const rel = relative(base, abs);
  return toPosix(rel && !isAbsolute(rel) ? rel : abs);
}

/**
 * Locate an executable on PATH without spawning `which` — this runs on every
 * executor construction, and a subprocess to decide whether to use a subprocess
 * is a poor trade. Exported for the doctor/tests.
 */
export function findOnPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not in this dir — keep looking */
    }
  }
  return null;
}

/**
 * Translate the glob subset `find` accepts (`*`, `**`, `?`, `[abc]`, `[!abc]`)
 * into a RegExp.
 *
 * Hand-rolled rather than `fs.glob`/`path.matchesGlob`, which are still flagged
 * experimental on Node 22: they warn at runtime, and semantics that shift under
 * us would silently change which branch a plan takes. Unmatched syntax degrades
 * to a literal rather than throwing, per the evaluator's total-function contract.
 */
export function globToRegExp(glob: string): RegExp {
  let src = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` spans zero or more directories, so `**/*.ts` also matches a
        // top-level a.ts; a bare `**` spans anything, separators included.
        if (glob[i + 2] === "/") {
          src += "(?:.*/)?";
          i += 2;
        } else {
          src += ".*";
          i += 1;
        }
      } else {
        src += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      src += "[^/]";
      continue;
    }
    if (ch === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end > i) {
        const body = glob.slice(i + 1, end);
        src += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = end;
        continue;
      }
      // Unclosed class: fall through and treat the bracket as a literal.
    }
    src += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${src}$`);
}

/**
 * Lexical containment: `abs` must BE the root or sit under it.
 *
 * Compared lexically and never through realpath. A worktree's `node_modules` and
 * any pnpm store are symlink farms pointing outside the root, so a realpath
 * check would reject reads the user plainly intended — and on macOS it would
 * also have to reconcile /var → /private/var on one side of the comparison only.
 * The trailing separator is what stops /repo-evil passing for root /repo.
 */
function isWithin(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
}

type Located = { abs: string; err?: undefined } | { abs?: undefined; err: OpResult };

function locate(root: string, base: string, raw: string, label: string): Located {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  if (!isWithin(root, abs)) {
    return {
      err: fail(
        label,
        `"${raw}" resolves to ${abs}, outside the predexec root ${root} — refusing to read outside the session root`,
      ),
    };
  }
  return { abs };
}

async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * Resolve an op's optional `path` to an existing target, defaulting to the op's
 * cwd. Missing paths report where they were resolved from: the model needs the
 * base to fix its plan, and "ENOENT" alone never tells it that.
 */
async function target(
  op: ToolOp,
  root: string,
  base: string,
  label: string,
): Promise<{ abs: string; isDir: boolean; err?: undefined } | { abs?: undefined; isDir?: undefined; err: OpResult }> {
  const raw = op.path === undefined ? "." : String(op.path);
  const found = locate(root, base, raw, label);
  if (found.err) return { err: found.err };
  const info = await statOrNull(found.abs);
  if (!info) return { err: fail(label, `path not found: ${raw} (resolved against ${base})`) };
  return { abs: found.abs, isDir: info.isDirectory() };
}

/**
 * Run an accelerator binary, keeping the process's own exit status distinct from
 * "the process never ran". rg encodes real meaning in its exit code (1 = no
 * matches, 2 = bad pattern), while a killed or missing child reports a string
 * errno — collapsing the two would turn a broken regex into an empty result set.
 */
async function runBinary(
  bin: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { maxBuffer: MAX_BUFFER, encoding: "utf8", signal });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    if (typeof e.code === "number") return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code };
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error(`output exceeded ${MAX_BUFFER / (1024 * 1024)}MB — narrow the pattern or scope it with \`path\``);
    }
    throw err;
  }
}

/**
 * Depth-first file walk used whenever rg/fd are absent.
 *
 * Symlinked directories are not descended: `readdir` dirents reflect lstat, so
 * `isDirectory()` is false for them. That drops cycle risk for free and matches
 * fd, which also needs an explicit `--follow`.
 */
async function walkFiles(dir: string, signal?: AbortSignal): Promise<{ files: string[]; capped: boolean }> {
  const files: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    if (signal?.aborted) throw new Error("aborted");
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // unreadable dir: skip it rather than failing the whole walk
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
      } else if (entry.isFile()) {
        if (files.length >= MAX_WALK_FILES) return { files, capped: true };
        files.push(abs);
      }
    }
  }
  return { files, capped: false };
}

// ── read ────────────────────────────────────────────────────────────────────

async function readOp(op: ToolOp, root: string, base: string): Promise<OpResult> {
  const raw = String(op.path ?? "");
  if (!raw) return fail("read", "missing required arg `path`");
  const found = locate(root, base, raw, "read");
  if (found.err) return found.err;
  const info = await statOrNull(found.abs);
  if (!info) return fail("read", `path not found: ${raw} (resolved against ${base})`);
  if (info.isDirectory()) return fail("read", `${raw} is a directory — use {tool:"ls"} to list it`);

  const buf = await readFile(found.abs);
  if (buf.includes(0)) {
    return fail("read", `${raw} looks like a binary file — this adapter reads text only`);
  }

  const lines = buf.toString("utf8").split("\n");
  const total = lines.length;
  const offset = typeof op.offset === "number" ? op.offset : 1;
  const start = Math.max(0, offset - 1);
  // An out-of-range offset returns empty stdout if it is allowed to clamp, and
  // empty stdout is indistinguishable from an empty file to a negated `match`.
  if (start >= total) return fail("read", `offset ${offset} is past the end of ${raw} (${total} lines)`);
  const end = Math.min(start + (positiveInt(op.limit) ?? DEFAULT_READ_LINES), total);

  // Notices go to stderr, never stdout: a `numeric` edge extracting from stdout
  // would happily read the number out of "showing lines 1-2000 of 5000". A
  // caller-supplied `limit` that stops short of EOF is still truncation and
  // still gets the notice — silence there reads to the model as "whole file".
  return {
    stdout: lines.slice(start, end).join("\n"),
    stderr:
      end < total
        ? `read: showing lines ${start + 1}-${end} of ${total} in ${raw} — use offset=${end + 1} to continue`
        : "",
    exitCode: 0,
  };
}

// ── grep ────────────────────────────────────────────────────────────────────

interface Match {
  /** Relative to the op's cwd, posix-separated. */
  path: string;
  line: number;
  text: string;
}

async function grepOp(
  op: ToolOp,
  root: string,
  base: string,
  rg: string | null,
  signal?: AbortSignal,
): Promise<OpResult> {
  const pattern = String(op.pattern ?? "");
  if (!pattern) return fail("grep", "missing required arg `pattern`");
  const scope = await target(op, root, base, "grep");
  if (scope.err) return scope.err;

  const limit = positiveInt(op.limit) ?? DEFAULT_GREP_LIMIT;
  const context = positiveInt(op.context) ?? 0;
  const ignoreCase = op.ignoreCase === true;
  const literal = op.literal === true;
  const glob = op.glob === undefined ? undefined : String(op.glob);

  const notes: string[] = [];
  let matches: Match[];
  if (rg) {
    const found = await grepViaRg(rg, pattern, scope.abs, base, { ignoreCase, literal, glob }, signal);
    if (found.err) return found.err;
    matches = found.matches;
  } else {
    // Only a directory search has a file set to diverge over; on one named file
    // the note would be noise about a decision that was never made.
    if (scope.isDir) notes.push(`grep: ripgrep ${NO_GITIGNORE_NOTE}`);
    const found = await grepViaNode(pattern, scope.abs, scope.isDir, base, { ignoreCase, literal, glob }, signal);
    if (found.err) return found.err;
    if (found.capped) notes.push(walkCapNote("grep"));
    matches = found.matches;
  }

  if (matches.length > limit) {
    notes.push(`grep: ${limit} match limit reached — use limit=${limit * 2} for more, or narrow the pattern`);
  }
  const stdout = await formatMatches(matches.slice(0, limit), base, context);
  return { stdout, stderr: notes.join("\n"), exitCode: stdout ? 0 : 1 };
}

async function grepViaRg(
  rg: string,
  pattern: string,
  abs: string,
  base: string,
  flags: { ignoreCase: boolean; literal: boolean; glob?: string },
  signal?: AbortSignal,
): Promise<{ matches: Match[]; err?: undefined } | { matches?: undefined; err: OpResult }> {
  // `--null` terminates the path with a NUL, which is the only way to parse
  // `path:line:text` unambiguously when a path itself contains a colon.
  // `--with-filename` is not redundant: given a single explicit FILE, rg prints
  // bare `line:text` with no path at all, and every row would then be dropped by
  // the NUL parse below. `--hidden` plus the two exclusions line rg's default
  // file set up with the pure-Node walk's, so switching paths changes as little
  // as possible.
  const args = ["--null", "--with-filename", "--line-number", "--no-heading", "--color", "never", "--hidden", "--glob", "!.git", "--glob", "!node_modules"];
  if (flags.ignoreCase) args.push("--ignore-case");
  if (flags.literal) args.push("--fixed-strings");
  if (flags.glob) args.push("--glob", flags.glob);
  args.push("--", pattern, abs);

  const { stdout, stderr, code } = await runBinary(rg, args, signal);
  if (code >= 2) {
    return { err: fail("grep", stderr.trim() || `ripgrep exited ${code}`) };
  }

  const matches: Match[] = [];
  for (const line of stdout.split("\n")) {
    const nul = line.indexOf("\0");
    if (nul < 0) continue; // rg's out-of-band notices (e.g. binary files) have no NUL — skip, don't mis-parse
    const rest = line.slice(nul + 1);
    const colon = rest.indexOf(":");
    if (colon < 0) continue;
    const lineNo = Number(rest.slice(0, colon));
    if (!Number.isInteger(lineNo)) continue;
    matches.push({ path: relativize(base, line.slice(0, nul)), line: lineNo, text: rest.slice(colon + 1) });
  }
  // rg walks in its own order; sorting is what makes the accelerated and the
  // fallback paths return byte-identical output for the same file set.
  return { matches: sortMatches(matches) };
}

async function grepViaNode(
  pattern: string,
  abs: string,
  isDir: boolean,
  base: string,
  flags: { ignoreCase: boolean; literal: boolean; glob?: string },
  signal?: AbortSignal,
): Promise<
  { matches: Match[]; capped: boolean; err?: undefined } | { matches?: undefined; capped?: undefined; err: OpResult }
> {
  let re: RegExp;
  try {
    const source = flags.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
    re = new RegExp(source, flags.ignoreCase ? "i" : "");
  } catch (err) {
    return { err: fail("grep", `invalid pattern: ${errText(err)}`) };
  }
  let globRe: RegExp | undefined;
  if (flags.glob) {
    try {
      globRe = globToRegExp(flags.glob);
    } catch (err) {
      return { err: fail("grep", `invalid glob: ${errText(err)}`) };
    }
  }

  const walked = isDir ? await walkFiles(abs, signal) : { files: [abs], capped: false };
  const matches: Match[] = [];
  for (const file of walked.files) {
    if (signal?.aborted) throw new Error("aborted");
    const rel = relativize(base, file);
    if (globRe && !matchesGlob(globRe, rel, flags.glob!)) continue;
    let buf: Buffer;
    try {
      buf = await readFile(file);
    } catch {
      continue; // unreadable file: skip it, the same way rg does
    }
    if (buf.includes(0)) continue; // binary — rg skips these too
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      if (re.test(text)) matches.push({ path: rel, line: i + 1, text });
    }
  }
  return { matches: sortMatches(matches), capped: walked.capped };
}

const sortMatches = (matches: Match[]): Match[] =>
  matches.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));

/**
 * Render matches. Both search paths land here, so `context` is built from the
 * file by us rather than delegated to rg's own `-C` — one formatter means the
 * accelerated and fallback outputs cannot drift apart.
 */
async function formatMatches(matches: Match[], base: string, context: number): Promise<string> {
  if (context === 0) return matches.map((m) => `${m.path}:${m.line}:${m.text}`).join("\n");

  const cache = new Map<string, string[]>();
  const blocks: string[] = [];
  for (const m of matches) {
    let lines = cache.get(m.path);
    if (!lines) {
      try {
        lines = (await readFile(resolve(base, m.path), "utf8")).split("\n");
      } catch {
        lines = [];
      }
      cache.set(m.path, lines);
    }
    const from = Math.max(1, m.line - context);
    const to = Math.min(lines.length, m.line + context);
    const block: string[] = [];
    for (let n = from; n <= to; n++) {
      // rg's convention: `:` separates a match line, `-` a context line.
      const mark = n === m.line ? ":" : "-";
      block.push(`${m.path}${mark}${n}${mark}${lines[n - 1] ?? ""}`);
    }
    blocks.push(block.join("\n"));
  }
  return blocks.join("\n--\n");
}

// ── find ────────────────────────────────────────────────────────────────────

/** A pattern without a separator matches the basename too, the way `*.ts` is universally meant. */
function matchesGlob(re: RegExp, rel: string, glob: string): boolean {
  if (re.test(rel)) return true;
  return !glob.includes("/") && re.test(rel.slice(rel.lastIndexOf("/") + 1));
}

async function findOp(
  op: ToolOp,
  root: string,
  base: string,
  fd: string | null,
  signal?: AbortSignal,
): Promise<OpResult> {
  const pattern = String(op.pattern ?? "");
  if (!pattern) return fail("find", "missing required arg `pattern`");
  const scope = await target(op, root, base, "find");
  if (scope.err) return scope.err;
  if (!scope.isDir) return fail("find", `"${String(op.path)}" is a file — find searches a directory`);

  let re: RegExp;
  try {
    re = globToRegExp(pattern);
  } catch (err) {
    return fail("find", `invalid glob: ${errText(err)}`);
  }

  const notes: string[] = [];
  let files: string[];
  if (fd) {
    // fd only enumerates; the glob match, sort and cap stay with us so the two
    // paths differ in file set alone. `.` is fd's regex for "any character",
    // i.e. every name — the pattern is applied afterwards.
    const { stdout, stderr, code } = await runBinary(
      fd,
      ["--type", "f", "--color", "never", "--hidden", "--exclude", ".git", "--exclude", "node_modules", ".", scope.abs],
      signal,
    );
    if (code >= 2) return fail("find", stderr.trim() || `fd exited ${code}`);
    files = stdout.split("\n").filter(Boolean);
  } else {
    notes.push(`find: fd ${NO_GITIGNORE_NOTE}`);
    const walked = await walkFiles(scope.abs, signal);
    if (walked.capped) notes.push(walkCapNote("find"));
    files = walked.files;
  }

  const limit = positiveInt(op.limit) ?? DEFAULT_FIND_LIMIT;
  const hits = files
    .map((f) => relativize(base, f))
    .filter((rel) => matchesGlob(re, rel, pattern))
    .sort();
  if (hits.length > limit) {
    notes.push(`find: ${limit} result limit reached — use limit=${limit * 2} for more, or narrow the pattern`);
  }
  const stdout = hits.slice(0, limit).join("\n");
  return { stdout, stderr: notes.join("\n"), exitCode: stdout ? 0 : 1 };
}

// ── ls ──────────────────────────────────────────────────────────────────────

async function lsOp(op: ToolOp, root: string, base: string): Promise<OpResult> {
  const scope = await target(op, root, base, "ls");
  if (scope.err) return scope.err;
  if (!scope.isDir) return fail("ls", `${String(op.path ?? ".")} is not a directory — use {tool:"read"} for files`);

  const entries = await readdir(scope.abs, { withFileTypes: true });
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const names: string[] = [];
  for (const entry of entries) {
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      // Dirents report the link itself, so a symlinked directory needs a stat to
      // earn its trailing slash. A dangling link just stays slash-less.
      isDir = (await statOrNull(join(scope.abs, entry.name)))?.isDirectory() ?? false;
    }
    names.push(isDir ? `${entry.name}/` : entry.name);
  }

  const limit = positiveInt(op.limit) ?? DEFAULT_LS_LIMIT;
  const capped = names.length > limit;
  return {
    stdout: names.slice(0, limit).join("\n"),
    stderr: capped ? `ls: ${limit} entry limit reached — use limit=${limit * 2} for more` : "",
    // An empty directory is a fact, not a failure: exit 0 keeps `exit == 0`
    // edges meaning "the listing succeeded", as on the sibling adapters.
    exitCode: 0,
  };
}

// ── executor ────────────────────────────────────────────────────────────────

/**
 * Maps a predexec tool op to a node:fs implementation, normalizing to the
 * shell-like {stdout, stderr, exitCode} the core engine expects. Same shape as
 * the opencode adapter's executor; the harness differences live inside the ops.
 */
export function createToolExecutor(opts: ToolExecutorOptions): ToolExecutor {
  const root = resolve(opts.cwd);
  // Looked up once, not per op: PATH does not change mid-walk, and an explicit
  // null from the caller pins the pure-Node path.
  const rg = opts.rgPath === undefined ? findOnPath("rg") : opts.rgPath;
  const fd = opts.fdPath === undefined ? findOnPath("fd") : opts.fdPath;

  return async (op: ToolOp, runOpts: { cwd: string; signal?: AbortSignal }): Promise<OpResult> => {
    const label = String(op.tool);
    const base = resolve(runOpts.cwd);
    // The engine folds plan.cwd into RunOptions.cwd before we see it, so a plan
    // that points its cwd out of the session shows up here as an escaping base.
    // It gets its own message: "path not found" would send the model hunting for
    // the wrong mistake.
    if (!isWithin(root, base)) {
      return fail(label, `cwd ${base} is outside the predexec root ${root} — a plan's cwd may not escape the session root`);
    }
    try {
      switch (op.tool) {
        case "read":
          return await readOp(op, root, base);
        case "grep":
          return await grepOp(op, root, base, rg, runOpts.signal);
        case "find":
          return await findOp(op, root, base, fd, runOpts.signal);
        case "ls":
          return await lsOp(op, root, base);
        default:
          return { stdout: "", stderr: `unknown tool: ${op.tool}`, exitCode: 1 };
      }
    } catch (err) {
      return fail(label, errText(err));
    }
  };
}
