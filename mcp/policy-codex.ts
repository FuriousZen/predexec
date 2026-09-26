/**
 * predexec policy — Codex CLI execpolicy reader/checker (MCP adapter).
 *
 * Harness-facing (NOT part of pure `core/`): fs + env access lives here, like
 * policy.ts/policy-claude.ts. This one is load-bearing in a way the other two
 * are not: CODEX-RESEARCH.md §4 (measured, not just documented) — Codex spawns
 * MCP servers with `.env_clear()` and NO sandbox wrapper at all
 * (`stdio_server_launcher.rs`). A probe subprocess wrote to disk under a
 * read-only-sandboxed session with zero error. Codex's own approval flow
 * governs the *shell tool* it drives itself; it says nothing about what an MCP
 * server's subprocess does once predexec is inside the process boundary. So
 * unlike the Claude Code adapter (OS-level sandboxing backstops the hole this
 * module doesn't close) and unlike opencode (this module + the destructive
 * heuristic are still the only things standing between a plan's shell commands
 * and the real filesystem/network here too — Codex just has *nothing else*.
 *
 * Scope for v1 (CODEX-RESEARCH.md §4): execpolicy prefix rules
 * (`prefix_rule(pattern=[...], decision=...)`) from every layer Codex loads —
 * `/etc/codex/rules`, `$CODEX_HOME/rules`, and, for trusted directories, the
 * `.codex/rules` of each directory from the project root down to cwd (see
 * `readCodexRules`) — plus the project-trust gate. From `config.toml` only
 * `projects.*.trust_level` and `project_root_markers` are read. NOT read
 * here: `approval_policy`, `sandbox_mode`, `[permissions]` — those govern
 * Codex's own shell tool, not an MCP subprocess, so they say nothing this
 * checker needs to enforce.
 *
 * Precedence is most-restrictive-wins — `forbidden > prompt > allow`
 * (§4, and the live docs page, learn.chatgpt.com/docs/agent-configuration/
 * rules) — NOT last-match (opencode) or first-match-in-fixed-order (Claude
 * Code). `prompt` stops here exactly like `ask` does in policy-claude.ts:
 * predexec cannot prompt mid-walk, so an ask-equivalent is a stop. `allow`
 * never widens what predexec runs — predexec's own read-only enforcement
 * (destructive.ts) still gates everything upstream of this checker.
 *
 * Absent `decision`: verified directly against the live docs page (not just
 * CODEX-RESEARCH.md, which doesn't state it) — "`decision` (defaults to
 * `"allow"`)". So a `prefix_rule(pattern=[...])` with no `decision=` kwarg is a
 * COMPLETE, parseable rule with `decision: "allow"`, not a reason to fail the
 * file closed.
 *
 * The Starlark extractor does NOT evaluate Starlark. It is line/paren-balance
 * scanning for `prefix_rule(...)` calls, ignoring comments/blank
 * lines/`load(...)`/plain variable assignments and the non-command builtins
 * Codex itself writes (`network_rule(...)`, `host_executable(...)`), and it
 * fails a whole `.rules` file closed the moment it meets anything it cannot
 * confidently classify — same "unreadable, not silently wrong" contract
 * `toml-lite.ts` uses for `config.toml`. Pattern elements follow Codex
 * exactly: string literals (escapes decoded) are exact tokens, so `"*"` is a
 * literal `*`; a list of strings is a set of alternatives in any position. A
 * bare identifier (a variable like `ARGS`, which is not evaluated) truncates
 * the matchable prefix there — "matches anything from here on" is the
 * conservative reading of a value this extractor cannot see.
 *
 * Fail-closed, mirroring policy.ts's "config exists but will not parse"
 * precedent exactly: a `.rules` file OR a `config.toml` that EXISTS and fails
 * to parse lands in `unreadable`, and `createCodexPolicyChecker` then stops
 * EVERY command rather than guessing. A machine with no `~/.codex` at all is
 * unconfigured, not locked down — nothing to read means nothing to enforce.
 *
 * NOT representable here: Codex's session CLI flags (`--sandbox`, `-a`/
 * `--ask-for-approval`, `--profile`, `--full-auto`) are a config layer that
 * never touches disk (precedence 30, above the `.codex/` project layer) — same
 * caveat class as Claude Code's `--allowedTools`/`--disallowedTools`, and for
 * the same reason: a subprocess cannot see its parent's argv.
 *
 * Leading env-assignments AND wrapper commands are stripped from each
 * segment's tokens before prefix comparison — a fifth fail-open finding from
 * final review, closed the same way (5): `FOO=1 git push` and
 * `timeout 5 git push` must not dodge a `["git","push"]` rule any more than
 * they dodge `policy-claude.ts`'s equivalent `Bash(git push *)` rule there.
 * Shared command-inspection mechanics receive these host-specific wrapper
 * sets, while this adapter retains ownership of token-prefix matching and
 * precedence. The tokenized form is important because Codex rules compare
 * argv-like prefixes.
 * Matching takes the union of the raw and stripped token forms (same
 * reasoning as `policy-claude.ts`'s `forms` array): raw-only misses a
 * `["git","push"]` rule on `timeout 5 git push`, stripped-only misses a
 * `["timeout"]` rule on the same command.
 *
 * Hardened after adversarial review (four fail-open findings, all closed):
 * (1) a `;`-joined `.rules` line can register several complete `prefix_rule`
 * calls in one line — real, valid Starlark — so statement-splitting now also
 * cuts on top-level `;`, AND separately validates that a `prefix_rule(...)`'s
 * own balanced parens consume the ENTIRE statement (trailing content of any
 * kind — a stray `;` that splitting missed, no separator at all, anything —
 * fails the file closed rather than silently merging two calls' kwargs).
 * (2) command tokens are unquoted before prefix comparison, so `git "push"`
 * cannot dodge a `["git","push"]` rule by quoting. (3) the checker rescans
 * newline-joined lines and command-substitution bodies (`$(…)`/backticks/
 * `<(…)`/`>(…)`), mirroring `policy-claude.ts`'s equivalent defense — Codex
 * has no OS sandbox backstop, so a missed substitution here is worse than the
 * same miss on Claude Code. (4) a rules DIRECTORY that exists but can't be
 * listed (EACCES, ENOTDIR, …) now fails closed instead of reading identically
 * to "nothing configured here."
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  inspectCommandSubstitutionTree,
  splitCommandSegments,
  stripLeadingAssignmentsAndWrappers,
  tokenizeShellWords,
  type WrapperInspectionOptions,
} from "../core/index.ts";
import type { Operation } from "../core/types.ts";
import type { PolicyVerdict } from "./policy-claude.ts";
import { parseTomlLite } from "./toml-lite.ts";

export type CodexDecision = "allow" | "prompt" | "forbidden";

/** One pattern position: an exact token, or a list of alternative exact tokens. */
export type CodexPatternToken = string | string[];

export interface CodexRule {
  /**
   * The rule's prefix, in order; each position is an exact token or a list of
   * alternatives. A bare-identifier source element truncates this array
   * early — see the file header. `[]` matches every command.
   */
  pattern: CodexPatternToken[];
  decision: CodexDecision;
}

export interface CodexPolicyOptions {
  /** Overrides `env.CODEX_HOME` and the `~/.codex` default. Tests use this. */
  codexHome?: string;
  /** Env to read `CODEX_HOME` (and, as a homedir seam, `HOME`) from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The system config layer's folder; its `rules/` is read first. Defaults to `/etc/codex`. Tests use this. */
  systemDir?: string;
}

const DECISIONS: ReadonlySet<CodexDecision> = new Set(["allow", "prompt", "forbidden"]);
const SEVERITY: Record<CodexDecision, number> = { allow: 0, prompt: 1, forbidden: 2 };

/**
 * `opts.codexHome` > `env.CODEX_HOME` > `~/.codex`. The real Codex CLI never
 * forwards `CODEX_HOME` to the MCP subprocess (measured, CODEX-RESEARCH.md
 * §5), so this third tier is what almost every real invocation hits.
 * `env.HOME` is consulted before falling back to `os.homedir()` — POSIX
 * `homedir()` itself checks `process.env.HOME` first, so this only makes the
 * seam visible to a passed-in `env` for tests; it changes nothing for a real
 * process, which always has its own `HOME` set.
 */
function resolveCodexHome(opts: CodexPolicyOptions): string {
  if (opts.codexHome) return opts.codexHome;
  const env = opts.env ?? process.env;
  if (env.CODEX_HOME) return env.CODEX_HOME;
  if (env.HOME) return join(env.HOME, ".codex");
  return join(homedir(), ".codex");
}

/** Index of the first `target` char outside a quoted string (`'` or `"`), or -1. */
function firstUnquotedIndex(text: string, target: string): number {
  let q: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === target) return i;
  }
  return -1;
}

/** Strip a `#` comment, string-aware (a `#` inside a quoted value survives). */
function stripLineComment(line: string): string {
  const idx = firstUnquotedIndex(line, "#");
  return idx === -1 ? line : line.slice(0, idx);
}

/** Net paren/bracket depth change of one line, ignoring quoted content. `(` and `[`
 * are tracked together — this extractor only needs to know when a statement
 * has fully closed, not which bracket kind closed it. */
function parenDelta(line: string): number {
  let depth = 0;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
  }
  return depth;
}

/**
 * Group a `.rules` file's lines into top-level statements (a `prefix_rule(...)`
 * call may span many lines; blank lines and comments are dropped first).
 * Returns `null` when brackets never balance — an unterminated statement is
 * exactly the "cannot confidently classify" case the whole file fails closed
 * on.
 *
 * A single bracket-balanced chunk can still hold MULTIPLE top-level
 * statements joined by `;` — real, valid Starlark
 * (`prefix_rule(...); prefix_rule(...)`) — so each chunk is further split on
 * top-level (depth-0, outside-quotes) `;` before being returned. Without this,
 * two complete calls on one line collapse into a single "statement" whose
 * `pattern`/`decision` kwargs get merged by `parsePrefixRuleCall`'s last-kwarg-
 * wins loop, silently dropping or downgrading whichever rule's kwargs lose the
 * merge (P1, adversarial review).
 */
function splitStatements(text: string): string[] | null {
  const rawChunks: string[] = [];
  let buf = "";
  let depth = 0;
  for (const raw of text.split(/\r\n|\n/)) {
    const line = stripLineComment(raw);
    if (depth === 0 && line.trim() === "") continue;
    buf += (buf ? "\n" : "") + line;
    depth += parenDelta(line);
    if (depth < 0) return null;
    if (depth === 0) {
      const trimmed = buf.trim();
      if (trimmed !== "") rawChunks.push(trimmed);
      buf = "";
    }
  }
  if (depth !== 0 || buf.trim() !== "") return null;

  const statements: string[] = [];
  for (const chunk of rawChunks) {
    const parts = splitTopLevelSemicolons(chunk);
    if (parts === null) return null;
    statements.push(...parts);
  }
  return statements;
}

/**
 * Split one already bracket-balanced chunk on top-level (depth 0, outside
 * quotes) `;` characters. `null` only if the chunk's own bracket/quote state
 * somehow doesn't end balanced — shouldn't happen given `chunk` was already
 * grouped to net-zero depth by `splitStatements`, kept as a safety net rather
 * than trusted blindly.
 */
function splitTopLevelSemicolons(chunk: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let q: '"' | "'" | null = null;
  let cur = "";
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i]!;
    if (q) {
      cur += c;
      if (c === "\\") (cur += chunk[i + 1] ?? ""), i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") (q = c), (cur += c);
    else if (c === "(" || c === "[") (depth++, (cur += c));
    else if (c === ")" || c === "]") {
      depth--;
      if (depth < 0) return null;
      cur += c;
    } else if (c === ";" && depth === 0) {
      const trimmed = cur.trim();
      if (trimmed !== "") parts.push(trimmed);
      cur = "";
    } else cur += c;
  }
  if (depth !== 0 || q !== null) return null;
  const trimmed = cur.trim();
  if (trimmed !== "") parts.push(trimmed);
  return parts;
}

/** Index of the char closing the paren opened at `stmt[openIdx]` (which must
 * be `(`), quote-aware — or `null` if it is never closed within `stmt`. */
function matchingParenClose(stmt: string, openIdx: number): number | null {
  let depth = 1;
  let q: '"' | "'" | null = null;
  for (let i = openIdx + 1; i < stmt.length; i++) {
    const c = stmt[i]!;
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return null;
    }
  }
  return null;
}

/**
 * True when `stmt` is EXACTLY one complete `<head>(...)` call — the balanced
 * close of the paren opened right after `head` must be `stmt`'s very last
 * character. Guards against trailing content silently riding along after a
 * legitimate call: two complete calls back-to-back, whether joined by a `;`
 * that splitting somehow missed, by nothing at all, or by any other separator
 * this extractor doesn't know about. "Cannot confidently classify" means the
 * file fails closed, not that the extra content is harmless (P1, adversarial
 * review — the belt to `splitTopLevelSemicolons`'s suspenders).
 */
function isExactBalancedCall(stmt: string, head: string): boolean {
  if (!stmt.startsWith(head)) return false;
  const openIdx = head.length - 1; // head ends in "("
  const closeIdx = matchingParenClose(stmt, openIdx);
  return closeIdx !== null && closeIdx === stmt.length - 1;
}

/** Split `text` on top-level commas — depth-aware over `()`/`[]`, quote-aware. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let q: '"' | "'" | null = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    cur += c;
    if (q) {
      if (c === "\\") (cur += text[i + 1] ?? ""), i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      parts.push(cur.slice(0, -1));
      cur = "";
    }
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts;
}

const STARLARK_SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
};

/**
 * A whole-string Starlark string literal (`"..."`, `'...'`, triple-quoted, or
 * `r`-prefixed raw), with escapes decoded — or `null` if `text` (trimmed) is
 * not exactly one literal. `"a\\b"` in a rules file is the three-character
 * string `a\b`; comparing the undecoded source text let such a rule never
 * match (CX-6). An escape Starlark would reject makes the literal `null`, so
 * the file fails closed rather than guessing.
 */
function parseStarlarkString(text: string): string | null {
  let t = text.trim();
  let raw = false;
  if (t[0] === "r" || t[0] === "R") (raw = true), (t = t.slice(1));
  const q = t[0];
  if (q !== '"' && q !== "'") return null;
  const delim = t.startsWith(q.repeat(3)) ? q.repeat(3) : q;
  if (t.length < delim.length * 2 || !t.endsWith(delim)) return null;
  const body = t.slice(delim.length, t.length - delim.length);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === q && delim.length === 1) return null; // an unescaped closing quote mid-string: not one literal
    if (c === "\n" && delim.length === 1) return null;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    if (raw) {
      out += c + next; // raw strings keep the backslash; it still protects a following quote
      i++;
      continue;
    }
    const simple = STARLARK_SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      out += simple;
      i++;
    } else if (next === "\n") i++;
    else if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0];
      out += String.fromCodePoint(parseInt(oct, 8));
      i += oct.length;
    } else {
      const width = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0;
      const hex = body.slice(i + 2, i + 2 + width);
      if (width === 0 || !new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) return null;
      const code = parseInt(hex, 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
      out += String.fromCodePoint(code);
      i += 1 + width;
    }
  }
  return out;
}

/** True when `text` (trimmed) is a `[...]` array literal of string literals
 * only — the one shape this extractor treats as an ignorable variable
 * assignment's RHS. */
function isStringListLiteral(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return false;
  const inner = t.slice(1, -1).trim();
  if (inner === "") return true;
  return splitTopLevel(inner, ",").every((el) => el.trim() === "" || parseStarlarkString(el) !== null);
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/s;

/**
 * Parse one `.rules` file's `prefix_rule(...)` calls, or `null` when anything
 * in it can't be confidently classified — the caller then fails the whole
 * file closed. See the file header for what "confidently classify" covers.
 */
function parseRulesFile(text: string): CodexRule[] | null {
  const statements = splitStatements(text);
  if (statements === null) return null;

  const rules: CodexRule[] = [];
  for (const stmt of statements) {
    if (isExactBalancedCall(stmt, "load(")) continue; // ignorable
    // Codex's own UI appends `network_rule(...)` to default.rules
    // (codex-rs/execpolicy/src/amend.rs:85-123), and `host_executable(...)`
    // is a documented builtin (execpolicy/src/parser.rs:410,437). Neither
    // says anything about which shell commands may run, so each is skipped
    // as one balanced call; any OTHER unknown call still fails the file.
    if (isExactBalancedCall(stmt, "network_rule(") || isExactBalancedCall(stmt, "host_executable(")) continue;

    if (stmt.startsWith("prefix_rule(")) {
      // Must be EXACTLY one complete call — trailing content of any kind
      // (including a second, un-split call) fails the whole file closed
      // rather than being fed into the arg parser below (P1).
      if (!isExactBalancedCall(stmt, "prefix_rule(")) return null;
      const rule = parsePrefixRuleCall(stmt);
      if (rule === null) return null;
      rules.push(rule);
      continue;
    }

    const assignment = ASSIGNMENT_RE.exec(stmt);
    if (assignment) {
      const rhs = assignment[1]!.trim();
      if (parseStarlarkString(rhs) !== null || isStringListLiteral(rhs)) continue; // ignorable
      return null; // assignment of something other than a string/list literal
    }

    return null; // unrecognized statement shape
  }
  return rules;
}

const TRUNCATE = Symbol("truncate");
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * One `pattern` element, as Codex reads it (execpolicy/src/parser.rs
 * `parse_pattern_token`): a string literal matches that exact token — `"*"`
 * is a literal `*`, not a glob (execpolicy/src/rule.rs `PatternToken::matches`);
 * a list of string literals is a set of alternatives, in ANY position
 * including the first. A bare identifier (a Starlark variable this extractor
 * does not evaluate) returns `TRUNCATE`: the rule then matches anything from
 * that position on — the over-blocking direction. Anything else (an empty
 * alternatives list, a non-string) is `null`: Codex rejects the file, so it
 * fails closed here too.
 */
function parsePatternToken(el: string): CodexPatternToken | typeof TRUNCATE | null {
  if (IDENTIFIER_RE.test(el)) return TRUNCATE;
  if (el.startsWith("[") && el.endsWith("]")) {
    const alts: string[] = [];
    for (const alt of splitTopLevel(el.slice(1, -1), ",")) {
      if (alt.trim() === "") continue;
      const literal = parseStarlarkString(alt);
      if (literal === null) return null;
      alts.push(literal);
    }
    if (alts.length === 0) return null;
    return alts.length === 1 ? alts[0]! : alts;
  }
  return parseStarlarkString(el);
}

/** Parse one balanced `prefix_rule(...)` statement's kwargs into a `CodexRule`,
 * or `null` when `pattern`/`decision` can't be confidently extracted. */
function parsePrefixRuleCall(stmt: string): CodexRule | null {
  const inner = stmt.slice("prefix_rule(".length, -1);
  const args = splitTopLevel(inner, ",")
    .map((a) => a.trim())
    .filter((a) => a !== "");

  let patternText: string | null = null;
  let decisionText: string | null = null;
  for (const arg of args) {
    const eq = firstUnquotedIndex(arg, "=");
    if (eq === -1) return null; // positional args aren't a documented shape
    const key = arg.slice(0, eq).trim();
    const value = arg.slice(eq + 1).trim();
    if (key === "pattern") patternText = value;
    else if (key === "decision") decisionText = value;
    // Other kwargs (e.g. a `comment=` string) say nothing about matching and
    // are structurally already consumed by the top-level split — safe to skip.
  }
  if (patternText === null) return null; // a prefix_rule with no pattern can't be matched at all

  if (!patternText.startsWith("[") || !patternText.endsWith("]")) return null;
  const elements = splitTopLevel(patternText.slice(1, -1), ",")
    .map((el) => el.trim())
    .filter((el, i, all) => el !== "" || i < all.length - 1);
  if (elements.length === 0) return null; // Codex: "pattern cannot be empty" (parser.rs parse_pattern)
  const pattern: CodexPatternToken[] = [];
  for (const el of elements) {
    const token = parsePatternToken(el);
    if (token === null) return null;
    if (token === TRUNCATE) break; // bare identifier (e.g. ARGS): wildcard from here on
    pattern.push(token);
  }

  let decision: CodexDecision = "allow"; // verified default, see file header
  if (decisionText !== null) {
    const literal = parseStarlarkString(decisionText);
    if (literal === null || !DECISIONS.has(literal as CodexDecision)) return null;
    decision = literal as CodexDecision;
  }

  return { pattern, decision };
}

/**
 * `<dir>/*.rules`, sorted for determinism. Reads into `rules`/`unreadable`;
 * an ABSENT directory (`ENOENT`) is the normal case, not an error. Any OTHER
 * failure to list it (`EACCES`, `ENOTDIR`, ...) means a rules directory
 * EXISTS and could not be read — that must fail closed exactly like an
 * unreadable file does, not silently read identically to "nothing configured
 * here" (P3, adversarial review).
 */
function collectRulesDir(dir: string, rules: CodexRule[], unreadable: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".rules"))
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") unreadable.push(dir);
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const parsed = parseRulesFile(readFileSync(path, "utf8"));
      if (parsed === null) unreadable.push(path);
      else rules.push(...parsed);
    } catch {
      unreadable.push(path);
    }
  }
}

/** Codex canonicalizes paths before trust lookups; a path that cannot be resolved keeps its lexical form. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `dir` and its ancestors, nearest first. The walk stops at the filesystem
 * root or at `$HOME`'s parent, whichever comes first (ruling for Task 13): a
 * marker above the user's home directory (say `/Users/.git`) must not turn
 * every session into one giant "project".
 */
function ancestors(dir: string, homeParent: string): string[] {
  const out: string[] = [];
  for (let cur = dir; ; cur = dirname(cur)) {
    out.push(cur);
    if (cur === homeParent || dirname(cur) === cur) return out;
  }
}

/** A `.git` DIRECTORY only counts with a `HEAD` in it (config/src/loader/mod.rs discover_project_root). */
function hasMarker(dir: string, marker: string): boolean {
  const path = join(dir, marker);
  if (!existsSync(path)) return false;
  return marker !== ".git" || !isDirectory(path) || existsSync(join(path, "HEAD"));
}

/**
 * The main worktree root for a linked worktree: `<checkout>/.git` is a file
 * `gitdir: <main>/.git/worktrees/<name>`, whose `commondir` names the main
 * `.git`. For an ordinary checkout it is the checkout itself. Codex also
 * checks the worktree's back-pointer before trusting it
 * (core/src/worktree_trust_tests.rs); predexec skips that ownership check on
 * purpose — here, inheriting trust only LOADS MORE restrictions, so a forged
 * pointer can over-block, never under-block.
 */
function mainWorktreeRoot(cwd: string, homeParent: string): string | null {
  for (const dir of ancestors(cwd, homeParent)) {
    const dotGit = join(dir, ".git");
    if (!hasMarker(dir, ".git")) continue;
    if (isDirectory(dotGit)) return dir;
    try {
      const gitdirLine = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
      if (!gitdirLine) return dir;
      const gitdir = resolve(dir, gitdirLine[1]!);
      const commondirFile = join(gitdir, "commondir");
      if (!existsSync(commondirFile)) return dir;
      const common = canonicalPath(resolve(gitdir, readFileSync(commondirFile, "utf8").trim()));
      return basename(common) === ".git" ? dirname(common) : dir;
    } catch {
      return dir;
    }
  }
  return null;
}

type TrustLevel = "trusted" | "untrusted";

interface TrustConfig {
  /** `[projects."<key>"] trust_level`, entries without a trust_level dropped (mod.rs:1285-1288). */
  projects: Array<{ key: string; spellings: Set<string>; level: TrustLevel }>;
  markers: string[];
}

/**
 * Read ONLY what trust and project-root resolution need from config.toml:
 * `projects.*.trust_level` and `project_root_markers`. Shapes Codex itself
 * would reject (config/src/loader/mod.rs:1025 deserializes `projects` as a
 * map of `{ trust_level }`; project_root_markers.rs requires an array of
 * strings) return `null` so the caller fails closed. Tolerated TOML errors
 * outside those keys come back as debug-only `warnings`.
 */
function readTrustConfig(configPath: string, warnings: string[]): TrustConfig | null {
  const empty: TrustConfig = { projects: [], markers: [".git"] };
  if (!existsSync(configPath)) return empty;
  let parsed: ReturnType<typeof parseTomlLite>;
  try {
    parsed = parseTomlLite(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
  if (!parsed.ok) return null;
  for (const w of parsed.warnings ?? []) warnings.push(`${configPath}: ${w}`);
  const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

  const config = { ...empty, projects: [] as TrustConfig["projects"] };
  const projects = parsed.value.projects;
  if (projects !== undefined) {
    if (!isTable(projects)) return null;
    for (const [key, entry] of Object.entries(projects)) {
      if (!isTable(entry)) return null;
      const level = entry.trust_level;
      if (level === undefined) continue;
      if (level !== "trusted" && level !== "untrusted") return null;
      config.projects.push({ key, spellings: new Set([resolve(key), canonicalPath(key)]), level });
    }
  }
  const markers = parsed.value.project_root_markers;
  if (markers !== undefined) {
    if (!Array.isArray(markers) || !markers.every((m) => typeof m === "string")) return null;
    config.markers = markers as string[];
  }
  return config;
}

/**
 * Trust for one lookup key (mod.rs:1400 project_trust_for_lookup_key): the
 * exact config key first, then any key that resolves to the same canonical
 * path. Where several spellings disagree, `trusted` wins — for predexec a
 * trusted layer only adds restrictions, so that is the over-blocking side.
 */
function trustFor(config: TrustConfig, key: string): TrustLevel | null {
  const exact = config.projects.filter((p) => p.key === key);
  const matches = exact.length > 0 ? exact : config.projects.filter((p) => p.spellings.has(key));
  if (matches.length === 0) return null;
  return matches.some((p) => p.level === "trusted") ? "trusted" : "untrusted";
}

/**
 * Read execpolicy rules the way Codex layers them (core/src/exec_policy.rs:
 * 663-681 walks config layers low to high and loads `<layer folder>/rules`):
 *   1. system: `<systemDir>/rules` (default `/etc/codex/rules`)
 *   2. user: `$CODEX_HOME/rules` (env, else `~/.codex`)
 *   3. project: for each directory from the project root down to cwd, its
 *      `.codex/rules` — only when that directory is trusted.
 *
 * Project root (config/src/loader/mod.rs:1490 discover_project_root): the
 * nearest ancestor of the CANONICAL cwd holding one of `project_root_markers`
 * (default `[".git"]`), else cwd itself. Trust per directory
 * (mod.rs:1041-1080 decision_for_dir): the directory's own entry (canonical
 * spelling, then the original spelling for cwd; mod.rs:1378), else the
 * project root's, else the main worktree root's (mod.rs:1249-1340). A
 * `.codex` that is `$CODEX_HOME` itself is the user layer, not a project one.
 *
 * `unreadable` lists files that EXIST but could not be read — the caller
 * fails closed on those. `warnings` is debug-only (tolerated config.toml
 * errors outside `projects`): never a stop, never shown as one.
 */
export function readCodexRules(
  cwd: string,
  opts: CodexPolicyOptions = {},
): { rules: CodexRule[]; unreadable: string[]; warnings: string[] } {
  const rules: CodexRule[] = [];
  const unreadable: string[] = [];
  const warnings: string[] = [];

  collectRulesDir(join(opts.systemDir ?? "/etc/codex", "rules"), rules, unreadable);
  const codexHome = resolveCodexHome(opts);
  collectRulesDir(join(codexHome, "rules"), rules, unreadable);

  const configPath = join(codexHome, "config.toml");
  const config = readTrustConfig(configPath, warnings);
  if (config === null) {
    unreadable.push(configPath);
    return { rules, unreadable, warnings };
  }

  const env = opts.env ?? process.env;
  const homeParent = dirname(canonicalPath(env.HOME || homedir()));
  const originalCwd = resolve(cwd);
  const canonicalCwd = canonicalPath(cwd);
  const cwdAncestors = ancestors(canonicalCwd, homeParent);
  const projectRoot =
    config.markers.length === 0
      ? canonicalCwd
      : (cwdAncestors.find((dir) => config.markers.some((m) => hasMarker(dir, m))) ?? canonicalCwd);
  const repoRoot = mainWorktreeRoot(canonicalCwd, homeParent);
  const codexHomeCanonical = canonicalPath(codexHome);

  const layerDirs = cwdAncestors.slice(0, cwdAncestors.indexOf(projectRoot) + 1).reverse();
  for (const dir of layerDirs) {
    const dotCodex = join(dir, ".codex");
    if (!isDirectory(dotCodex) || canonicalPath(dotCodex) === codexHomeCanonical) continue;
    const ownKeys = dir === canonicalCwd && originalCwd !== canonicalCwd ? [dir, originalCwd] : [dir];
    const lookupKeys = [...ownKeys, projectRoot, ...(repoRoot ? [repoRoot] : [])];
    let level: TrustLevel | null = null;
    for (const key of lookupKeys) if ((level = trustFor(config, key)) !== null) break;
    if (level === "trusted") collectRulesDir(join(dotCodex, "rules"), rules, unreadable);
  }

  return { rules, unreadable, warnings };
}

function formatPattern(pattern: CodexPatternToken[]): string {
  return pattern.length ? pattern.map((tok) => (Array.isArray(tok) ? tok.join("|") : tok)).join(" ") : "*";
}

function matchesPrefix(pattern: CodexPatternToken[], tokens: string[]): boolean {
  return (
    tokens.length >= pattern.length &&
    pattern.every((tok, i) => (Array.isArray(tok) ? tok.includes(tokens[i]!) : tokens[i] === tok))
  );
}

/**
 * Remove shell line continuations (`\<newline>`) outside single quotes, as
 * the shell does before word splitting. Without this, the per-line rescan
 * below split `cat \<newline>.env` into `cat \` and `.env`, and neither
 * matched a forbidden `["cat",".env"]` rule.
 */
function joinLineContinuations(text: string): string {
  let out = "";
  let single = false;
  let double = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (single) {
      if (c === "'") single = false;
      out += c;
    } else if (c === "'" && !double) (single = true), (out += c);
    else if (c === '"') (double = !double), (out += c);
    else if (c === "\\") {
      if (text[i + 1] === "\n") i++;
      else if (text[i + 1] === "\r" && text[i + 2] === "\n") i += 2;
      else (out += c + (text[i + 1] ?? "")), i++;
    } else out += c;
  }
  return out;
}

/**
 * Wrappers Claude Code strips before matching Bash rules — duplicated here,
 * same set, same job: see `policy-claude.ts`'s `WRAPPERS` for the full
 * rationale (`npx`/`docker exec` are pointedly absent from the host's own
 * list, so they stay absent here too, for parity rather than by omission).
 */
const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "noglob"]);
/** Wrappers that take their own options, whose flags/durations are consumed too. */
const OPTION_TAKING_WRAPPERS = new Set(["timeout", "time", "nice", "stdbuf"]);
/** `time` options whose following token is a format/output argument. */
const OPTION_ARGUMENTS = new Map([
  ["time", new Set(["-f", "--format", "-o", "--output"])],
]);
/** Stripped only when NOT followed by a flag: `command -v foo` looks a command up rather than running it, and `xargs -n1 grep` is matched as an xargs command. */
const BARE_ONLY_WRAPPERS = new Set(["command", "builtin", "xargs"]);
const DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;
const WRAPPER_OPTIONS: WrapperInspectionOptions = {
  wrappers: WRAPPERS,
  optionTakingWrappers: OPTION_TAKING_WRAPPERS,
  optionArguments: OPTION_ARGUMENTS,
  bareOnlyWrappers: BARE_ONLY_WRAPPERS,
  durationPattern: DURATION_RE,
};

/**
 * Build the shell portion of the operation-aware policy callback for the engine. Each pipeline
 * segment (via core's `splitCommandSegments`, same as policy.ts/
 * policy-claude.ts) is judged independently, so a compound
 * `git status && git push origin main` cannot smuggle the push past a
 * `["git","push"]` forbidden rule.
 *
 * Newline-joined lines and command-substitution bodies are rescanned too
 * (bounded to 4 levels of nesting), mirroring `policy-claude.ts`'s equivalent
 * defense — `splitCommandSegments` does not split on `\n`, and a substitution
 * body is otherwise invisible to matching (P2, adversarial review).
 *
 * Most-restrictive-wins across ALL rules matching a segment
 * (`forbidden > prompt > allow`) — unlike opencode's last-match or Claude
 * Code's fixed deny→ask→allow order, so every matching rule is scanned before
 * deciding, not just the first or last hit.
 *
 * `unreadable` paths stop EVERY command: a policy file exists and could not be
 * read, so running anything would be guessing — the worst possible moment to
 * assume "allow".
 */
export function createCodexPolicyChecker(
  rules: CodexRule[],
  unreadable: string[] = [],
): (operation: Operation) => PolicyVerdict {
  if (unreadable.length > 0) {
    const why =
      `cannot read your Codex execpolicy configuration (${unreadable[0]} is not valid) — ` +
      `predexec stops rather than run commands your policy might forbid or prompt on; fix that file to continue`;
    return (operation: Operation) => {
      if (typeof operation === "string") return why;
      if (operation.tool === "bash" && typeof operation.command === "string") return why;
      return null;
    };
  }
  return (operation: Operation) => {
    const cmd = typeof operation === "string"
      ? operation
      : operation.tool === "bash" && typeof operation.command === "string" ? operation.command : null;
    if (cmd === null) return null;
    try {
      const inspected = inspectCommandSubstitutionTree(cmd);
      for (const text of inspected.commands) {
          for (const line of joinLineContinuations(text).split("\n")) {
            for (const segment of splitCommandSegments(line)) {
              const trimmed = segment.trim();
              if (!trimmed) continue;
              const rawTokens = tokenizeShellWords(trimmed);
              const strippedTokens = stripLeadingAssignmentsAndWrappers(rawTokens, WRAPPER_OPTIONS);
              // Union of raw and stripped forms: raw-only misses a
              // `["git","push"]` rule on `FOO=1 git push` / `timeout 5 git
              // push`; stripped-only misses a `["timeout"]` rule on the same
              // command (see module header).
              const tokenForms = rawTokens.length === strippedTokens.length && rawTokens.every((token, i) => token === strippedTokens[i])
                ? [rawTokens]
                : [rawTokens, strippedTokens];
              let winner: CodexRule | null = null;
              for (const rule of rules) {
                const matches = tokenForms.some((toks) => matchesPrefix(rule.pattern, toks));
                if (matches && (!winner || SEVERITY[rule.decision] > SEVERITY[winner.decision])) winner = rule;
              }
              if (winner && winner.decision !== "allow") return formatPattern(winner.pattern);
            }
          }
      }
      if (!inspected.complete) return "incomplete shell syntax (policy inspection budget exceeded)";
      return null;
    } catch {
      return "incomplete shell syntax (policy inspection failed)";
    }
  };
}
