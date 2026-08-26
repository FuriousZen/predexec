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
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { splitCommandSegments } from "../core/index.ts";
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
 * call may span many lines; blank lines and comments are dropped first). Returns
 * `null` when brackets never balance — an unterminated statement is exactly the
 * "cannot confidently classify" case the whole file fails closed on.
 */
function splitStatements(text: string): string[] | null {
  const statements: string[] = [];
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
      if (trimmed !== "") statements.push(trimmed);
      buf = "";
    }
  }
  if (depth !== 0 || buf.trim() !== "") return null;
  return statements;
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
    if (stmt.startsWith("load(") && stmt.endsWith(")")) continue; // ignorable

    if (stmt.startsWith("prefix_rule(") && stmt.endsWith(")")) {
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

/** `<dir>/*.rules`, sorted for determinism. Reads into `rules`/`unreadable`;
 * an absent directory is the normal case, not an error. */
function collectRulesDir(dir: string, rules: CodexRule[], unreadable: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".rules"))
      .sort();
  } catch {
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
            ? (projects as Record<string, unknown>)[projectDir]
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

  if (trusted) collectRulesDir(join(projectDir, ".codex", "rules"), rules, unreadable);

  return { rules, unreadable };
}

function formatPattern(pattern: string[]): string {
  return pattern.length ? pattern.join(" ") : "*";
}

/**
 * Build the `checkCommandPolicy` callback for the engine. Each pipeline
 * segment (via core's `splitCommandSegments`, same as policy.ts/
 * policy-claude.ts) is judged independently, so a compound
 * `git status && git push origin main` cannot smuggle the push past a
 * `["git","push"]` forbidden rule.
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
): (cmd: string) => PolicyVerdict {
  if (unreadable.length > 0) {
    const why =
      `cannot read your Codex execpolicy configuration (${unreadable[0]} is not valid) — ` +
      `predexec stops rather than run commands your policy might forbid or prompt on; fix that file to continue`;
    return () => why;
  }
  if (rules.length === 0) return () => null;

  return (cmd: string) => {
    try {
      for (const segment of splitCommandSegments(cmd)) {
        const trimmed = segment.trim();
        if (!trimmed) continue;
        const tokens = trimmed.split(/\s+/);
        let winner: CodexRule | null = null;
        for (const rule of rules) {
          const matches = tokens.length >= rule.pattern.length && rule.pattern.every((tok, i) => tokens[i] === tok);
          if (matches && (!winner || SEVERITY[rule.decision] > SEVERITY[winner.decision])) winner = rule;
        }
        if (winner && winner.decision !== "allow") return formatPattern(winner.pattern);
      }
      return null;
    } catch {
      return null;
    }
  };
}
