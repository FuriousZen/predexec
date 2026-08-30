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
 * (`prefix_rule(pattern=[...], decision=...)` in `~/.codex/rules/*.rules` and,
 * for trusted projects only, `<repo>/.codex/rules/*.rules`) plus the
 * project-trust gate read from `config.toml`. NOT read here: `approval_policy`,
 * `sandbox_mode`, `[permissions]` — those govern Codex's own shell tool, not an
 * MCP subprocess, so they say nothing this checker needs to enforce.
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
 * lines/`load(...)`/plain variable assignments, and it fails a whole `.rules`
 * file closed the moment it meets anything it cannot confidently classify —
 * same "unreadable, not silently wrong" contract `toml-lite.ts` uses for
 * `config.toml`. `pattern` elements that aren't plain quoted string literals
 * (a bare identifier like `ARGS`, or a literal containing a glob wildcard like
 * `"*"`) truncate the matchable prefix there: matching stops being able to
 * confirm anything past that point, so treating it as "matches anything from
 * here on" is the conservative reading — the alternative (matching the glob
 * text literally) would silently narrow a broad rule into one that almost
 * never fires, which is the unsafe direction.
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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { splitCommandSegments } from "../core/index.ts";
import {
  extractCommandSubstitutions,
  extractShellCommandClauses,
  stripLeadingAssignmentsAndWrappers,
  tokenizeShellWords,
  type WrapperInspectionOptions,
} from "../command-inspection.ts";
import type { Operation } from "../core/types.ts";
import type { PolicyVerdict } from "./policy-claude.ts";
import { parseTomlLite } from "./toml-lite.ts";

export type CodexDecision = "allow" | "prompt" | "forbidden";

export interface CodexRule {
  /**
   * The rule's literal prefix tokens, in order. A non-literal source element
   * (bare identifier, or a quoted string containing a glob wildcard) truncates
   * this array early — see the file header. `[]` matches every command.
   */
  pattern: string[];
  decision: CodexDecision;
}

export interface CodexPolicyOptions {
  /** Overrides `env.CODEX_HOME` and the `~/.codex` default. Tests use this. */
  codexHome?: string;
  /** Env to read `CODEX_HOME` (and, as a homedir seam, `HOME`) from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
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

/** A whole-string double- or single-quoted literal, unescaped — or `null` if
 * `text` (trimmed) isn't one, meaning it is NOT a plain string literal. */
function asStringLiteral(text: string): string | null {
  const t = text.trim();
  if (t.length < 2) return null;
  const q = t[0];
  if ((q !== '"' && q !== "'") || t[t.length - 1] !== q) return null;
  const inner = t.slice(1, -1);
  if (inner.includes(q) || inner.includes("\n")) return null; // escapes/embedded quotes: not "plain"
  return inner;
}

/** True when `text` (trimmed) is a `[...]` array literal of plain string
 * literals only — the one shape this extractor treats as an ignorable
 * variable assignment's RHS. */
function isStringListLiteral(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return false;
  const inner = t.slice(1, -1).trim();
  if (inner === "") return true;
  return splitTopLevel(inner, ",").every((el) => asStringLiteral(el) !== null);
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
      if (asStringLiteral(rhs) !== null || isStringListLiteral(rhs)) continue; // ignorable
      return null; // assignment of something other than a string/list literal
    }

    return null; // unrecognized statement shape
  }
  return rules;
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
  const elementsText = patternText.slice(1, -1).trim();
  const pattern: string[] = [];
  if (elementsText !== "") {
    for (const el of splitTopLevel(elementsText, ",")) {
      const literal = asStringLiteral(el);
      if (literal === null) break; // bare identifier (e.g. ARGS): wildcard from here on
      if (literal.includes("*") || literal.includes("?")) break; // glob text: same treatment
      pattern.push(literal);
    }
  }

  let decision: CodexDecision = "allow"; // verified default, see file header
  if (decisionText !== null) {
    const literal = asStringLiteral(decisionText);
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

/**
 * Read execpolicy rules across `<codexHome>/rules/*.rules` (always) and, only
 * for a project `config.toml` marks trusted, `<projectDir>/.codex/rules/*.rules`
 * (§4: "untrusted projects skip all `.codex/` layers").
 *
 * `unreadable` reports files that EXIST but failed to parse (a `.rules` file
 * the extractor couldn't confidently classify, or a `config.toml` that exists
 * and doesn't parse as TOML) — the caller fails closed on those. A missing
 * `~/.codex` entirely means nothing to read, so `rules`/`unreadable` are both
 * empty: unconfigured, not locked down.
 */
export function readCodexRules(
  projectDir: string,
  opts: CodexPolicyOptions = {},
): { rules: CodexRule[]; unreadable: string[] } {
  const codexHome = resolveCodexHome(opts);
  if (!existsSync(codexHome)) return { rules: [], unreadable: [] };

  // Normalized once, used for both the trust-lookup key and the project rules
  // path: a trailing slash (or a `.`/`..` segment) must not silently make an
  // otherwise-trusted project compare as untrusted — that would skip real
  // restrictions the project owner wrote, which is the fail-open direction
  // (P-minor, adversarial review). Deliberately NOT a symlink-resolving
  // `realpathSync`: that requires the path to exist and would turn a
  // resolution problem into a thrown exception for what's supposed to be the
  // server's own cwd; `resolve()` handles the concretely-reported case
  // (trailing slash) without that new failure mode.
  const normalizedProjectDir = resolve(projectDir);

  const rules: CodexRule[] = [];
  const unreadable: string[] = [];

  collectRulesDir(join(codexHome, "rules"), rules, unreadable);

  const configPath = join(codexHome, "config.toml");
  let trusted = false;
  if (existsSync(configPath)) {
    try {
      const parsed = parseTomlLite(readFileSync(configPath, "utf8"));
      if (!parsed.ok) {
        unreadable.push(configPath);
      } else {
        const projects = (parsed.value as Record<string, unknown>).projects;
        const entry =
          projects && typeof projects === "object" && !Array.isArray(projects)
            ? (projects as Record<string, unknown>)[normalizedProjectDir]
            : undefined;
        trusted =
          !!entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).trust_level === "trusted";
      }
    } catch {
      unreadable.push(configPath);
    }
  }

  if (trusted) collectRulesDir(join(normalizedProjectDir, ".codex", "rules"), rules, unreadable);

  return { rules, unreadable };
}

function formatPattern(pattern: string[]): string {
  return pattern.length ? pattern.join(" ") : "*";
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
  if (rules.length === 0) return () => null;

  return (operation: Operation) => {
    const cmd = typeof operation === "string"
      ? operation
      : operation.tool === "bash" && typeof operation.command === "string" ? operation.command : null;
    if (cmd === null) return null;
    try {
      const pending = [cmd];
      for (let depth = 0; depth < 4 && pending.length > 0; depth++) {
        const batch = pending.splice(0, pending.length);
        for (const text of batch) {
          pending.push(...extractCommandSubstitutions(text));
          for (const line of text.split("\n")) {
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
              const clauseForms = tokenForms.flatMap((form) => [
                form,
                ...extractShellCommandClauses(form.join(" ")).map(tokenizeShellWords),
              ]);
              let winner: CodexRule | null = null;
              for (const rule of rules) {
                const matches = clauseForms.some(
                  (toks) => toks.length >= rule.pattern.length && rule.pattern.every((tok, i) => toks[i] === tok),
                );
                if (matches && (!winner || SEVERITY[rule.decision] > SEVERITY[winner.decision])) winner = rule;
              }
              if (winner && winner.decision !== "allow") return formatPattern(winner.pattern);
            }
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  };
}
