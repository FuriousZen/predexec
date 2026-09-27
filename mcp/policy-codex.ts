/**
 * predexec policy — Codex CLI execpolicy reader/checker (MCP adapter).
 *
 * Harness-facing (NOT part of pure `core/`): fs + env access lives here, like
 * policy.ts/policy-claude.ts. This one is load-bearing in a way the other two
 * are not: `openai/codex`'s `codex-rs/rmcp-client/src/stdio_server_launcher.rs`
 * + `.../utils.rs`'s `create_env_for_mcp_server` (measured against source at
 * commit 25270df, not just documented; full writeup in
 * docs/research/codex-plugin.md §2) — a local stdio MCP server's child env
 * starts EMPTY and is populated only from a small default allowlist plus
 * whatever the registration's `env_vars` names, and it is spawned with no
 * sandbox wrapper at all. A probe subprocess wrote to disk under a
 * read-only-sandboxed session with zero error. Codex's own approval flow
 * governs the *shell tool* it drives itself; it says nothing about what an MCP
 * server's subprocess does once predexec is inside the process boundary. So
 * unlike the Claude Code adapter (OS-level sandboxing backstops the hole this
 * module doesn't close) and unlike opencode (this module + the destructive
 * heuristic are still the only things standing between a plan's shell commands
 * and the real filesystem/network here too — Codex just has *nothing else*.
 *
 * Scope for v1 (`openai/codex`'s `codex-rs/execpolicy/` crate, plus config
 * layering in `codex-rs/config/src/requirements_layers/rules.rs`): execpolicy
 * prefix rules
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
 * (the live docs page, learn.chatgpt.com/docs/agent-configuration/
 * rules) — NOT last-match (opencode) or first-match-in-fixed-order (Claude
 * Code). `prompt` stops here exactly like `ask` does in policy-claude.ts:
 * predexec cannot prompt mid-walk, so an ask-equivalent is a stop. `allow`
 * never widens what predexec runs — predexec's own read-only enforcement
 * (destructive.ts) still gates everything upstream of this checker.
 *
 * Absent `decision`: verified directly against the live docs page — "`decision`
 * (defaults to `"allow"`)". So a `prefix_rule(pattern=[...])` with no `decision=` kwarg is a
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
  commandsWithUnresolvableOperands,
  describeUnresolvableOperand,
  inspectCommandSubstitutionTree,
  ruleHeadCouldMatch,
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
 * `opts.codexHome` > `env.CODEX_HOME` > `~/.codex`. A Codex MCP subprocess's
 * env starts EMPTY and is populated only from a small default allowlist plus
 * whatever the registration's `env_vars` names (`openai/codex`'s
 * `codex-rs/rmcp-client/src/utils.rs`'s `create_env_for_mcp_server`, measured
 * against source at commit 25270df — `CODEX_HOME` is not in the default
 * allowlist; full writeup in docs/research/codex-plugin.md §2). This repo's
 * own plugin registration (`.codex-plugin/mcp.json`) requests it via
 * `env_vars: ["CODEX_HOME"]`, but a bare `codex mcp add ... -- npx ...`
 * registration has no CLI flag for that (only a literal `--env KEY=VALUE`),
 * so this third tier is still what a non-plugin install hits in practice.
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

/**
 * Index just past the Starlark string literal whose opening quote is at
 * `text[i]`, or -1 when it never closes. `"""` / `'''` are recognised BEFORE a
 * single quote: every scanner below used to toggle on each lone quote, so an
 * odd number of quotes inside a triple-quoted literal (`'''Don't push'''`)
 * flipped the quote state for the rest of the statement — locking the user
 * out, or silently merging a forbidden `prefix_rule` into a neighbouring
 * skipped call (review I1). A backslash always protects the next character,
 * raw strings included (a raw string still cannot end on `\"`); `r`/`b`
 * prefixes are ordinary characters before the quote. A single-quoted literal
 * may not span a newline.
 */
function stringEnd(text: string, i: number): number {
  const q = text[i]!;
  const delim = text.startsWith(q.repeat(3), i) ? q.repeat(3) : q;
  for (let j = i + delim.length; j < text.length; j++) {
    const c = text[j]!;
    if (c === "\\") j++;
    else if (delim.length === 1 && c === "\n") return -1;
    else if (text.startsWith(delim, j)) return j + delim.length;
  }
  return -1;
}

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

/**
 * Group a `.rules` file into top-level statements: a statement ends at a
 * newline or `;` at bracket depth 0, outside strings and comments. `#`
 * comments are dropped; blank statements skipped. Returns `null` when a string
 * never closes or brackets never balance — the "cannot confidently classify"
 * case the whole file fails closed on.
 *
 * `;`-joined statements (`prefix_rule(...); prefix_rule(...)`, real Starlark)
 * come back separately, so two calls' kwargs are never merged (P1,
 * adversarial review).
 */
function splitStatements(text: string): string[] | null {
  const statements: string[] = [];
  let buf = "";
  let depth = 0;
  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed !== "") statements.push(trimmed);
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const end = stringEnd(text, i);
      if (end === -1) return null;
      buf += text.slice(i, end);
      i = end - 1;
    } else if (c === "#") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (depth === 0 && (c === "\n" || c === ";")) flush();
    else {
      if (OPENERS.has(c)) depth++;
      else if (CLOSERS.has(c) && --depth < 0) return null;
      buf += c;
    }
  }
  if (depth !== 0) return null;
  flush();
  return statements;
}

/** Index of the bracket closing the one opened at `text[openIdx]`, string-aware — or `null` if it never closes. */
function matchingClose(text: string, openIdx: number): number | null {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const end = stringEnd(text, i);
      if (end === -1) return null;
      i = end - 1;
    } else if (OPENERS.has(c)) depth++;
    else if (CLOSERS.has(c)) {
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
 * review).
 */
function isExactBalancedCall(stmt: string, head: string): boolean {
  if (!stmt.startsWith(head)) return false;
  return matchingClose(stmt, head.length - 1) === stmt.length - 1; // head ends in "("
}

/**
 * Split `text` on top-level `sep` — depth-aware over `()`/`[]`/`{}`,
 * string-aware. A trailing empty part (a trailing comma) is dropped; an empty
 * part anywhere else is kept as `""` so callers can reject it.
 */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const end = stringEnd(text, i);
      if (end === -1) break; // unbalanced: the remainder stays one part and fails to parse
      i = end - 1;
    } else if (OPENERS.has(c)) depth++;
    else if (CLOSERS.has(c)) depth--;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last !== "") parts.push(last);
  return parts;
}

/** Index of the first top-level (depth 0, outside strings) `target`, or -1. */
function firstTopLevelIndex(text: string, target: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const end = stringEnd(text, i);
      if (end === -1) return -1;
      i = end - 1;
    } else if (OPENERS.has(c)) depth++;
    else if (CLOSERS.has(c)) depth--;
    else if (c === target && depth === 0) return i;
  }
  return -1;
}

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$|^0[xX][0-9A-Fa-f]+$|^0[oO][0-7]+$/;

/**
 * True when `text` is a plain Starlark literal: a string, number, `True` /
 * `False` / `None`, or a list / tuple / dict built only from literals. Any
 * call or identifier reference makes it false. The arguments of a skipped
 * call and a `prefix_rule`'s non-matching kwargs must pass this: Starlark
 * EVALUATES them, so `justification=str(prefix_rule(...))` registers a rule
 * Codex enforces — skipping that text unread silently dropped it (review I2).
 */
function isLiteralExpr(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  if (parseStarlarkString(t) !== null) return true;
  if (NUMBER_RE.test(t) || t === "True" || t === "False" || t === "None") return true;
  const open = t[0]!;
  if (!OPENERS.has(open) || matchingClose(t, 0) !== t.length - 1) return false;
  const parts = splitTopLevel(t.slice(1, -1), ",");
  if (open === "{") {
    return parts.every((entry) => {
      const kv = splitTopLevel(entry, ":");
      return kv.length === 2 && isLiteralExpr(kv[0]!) && isLiteralExpr(kv[1]!);
    });
  }
  return parts.every(isLiteralExpr);
}

/**
 * The comma-separated arguments of a balanced call `head(...)`, as
 * `{ key, value }` (`key` null for a positional one) — or `null` when the
 * argument list is malformed: an empty argument, a keyword that is not an
 * identifier, or a keyword given twice (Starlark rejects all three).
 */
function callArguments(stmt: string, head: string): Array<{ key: string | null; value: string }> | null {
  const args: Array<{ key: string | null; value: string }> = [];
  const seen = new Set<string>();
  for (const arg of splitTopLevel(stmt.slice(head.length, -1), ",")) {
    if (arg === "") return null;
    const eq = firstTopLevelIndex(arg, "=");
    if (eq === -1 || arg[eq + 1] === "=") {
      args.push({ key: null, value: arg });
      continue;
    }
    const key = arg.slice(0, eq).trim();
    if (!IDENTIFIER_RE.test(key) || seen.has(key)) return null;
    seen.add(key);
    args.push({ key, value: arg.slice(eq + 1).trim() });
  }
  return args;
}

/** A call this extractor may skip only when every argument is a plain literal (review I2). */
function isLiteralOnlyCall(stmt: string, head: string): boolean {
  if (!isExactBalancedCall(stmt, head)) return false;
  const args = callArguments(stmt, head);
  return args !== null && args.every((a) => isLiteralExpr(a.value));
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
  // The literal ends at its FIRST unescaped closing delimiter (Starlark
  // semantics); anything after it — `+ str(prefix_rule(...)) + """b"""`, an
  // `if ... else`, another token — means `text` is an expression, not one
  // literal. Checking only `endsWith(delim)` accepted such a chain as a single
  // string and silently dropped the rule nested in it (review I2, round 2).
  if (stringEnd(t, 0) !== t.length) return null;
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
    // registers a prefix rule, so each is skipped — but only when every
    // argument is a plain literal: Starlark evaluates the arguments, so a
    // nested `prefix_rule(...)` in one is a rule Codex enforces (review I2).
    // `host_executable` narrows which absolute paths a rule's basename match
    // accepts (execpolicy/src/policy.rs:344-370); predexec matches every
    // absolute-path head by basename instead (see `createCodexPolicyChecker`),
    // which over-blocks, so skipping the narrowing is safe. Any other call,
    // or a skipped call with a non-literal argument, fails the file.
    if (stmt.startsWith("network_rule(") || stmt.startsWith("host_executable(")) {
      if (isLiteralOnlyCall(stmt, stmt.startsWith("network_rule(") ? "network_rule(" : "host_executable(")) continue;
      return null;
    }

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
/** `prefix_rule`'s other parameters (execpolicy/src/parser.rs:349-356) — they never affect matching. */
const PREFIX_RULE_IGNORED_KWARGS = new Set(["match", "not_match", "justification"]);
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
  const args = callArguments(stmt, "prefix_rule(");
  if (args === null) return null; // empty / duplicate / malformed argument (Minor 1)

  let patternText: string | null = null;
  let decisionText: string | null = null;
  for (const { key, value } of args) {
    if (key === null) return null; // positional args aren't a documented shape
    if (key === "pattern") patternText = value;
    else if (key === "decision") decisionText = value;
    else if (!PREFIX_RULE_IGNORED_KWARGS.has(key)) return null; // Codex rejects an unknown kwarg (a typo'd `decison=`)
    else if (!isLiteralExpr(value)) return null; // evaluated by Starlark: must not hide a call (review I2)
  }
  if (patternText === null) return null; // a prefix_rule with no pattern can't be matched at all

  if (!patternText.startsWith("[") || matchingClose(patternText, 0) !== patternText.length - 1) return null;
  const elements = splitTopLevel(patternText.slice(1, -1), ",");
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
 * `dir` and its ancestors, nearest first, up to the filesystem root. No
 * ceiling: Codex's `discover_project_root` walks every ancestor
 * (config/src/loader/mod.rs:1490-1526), so a marker above `$HOME` makes it
 * load that directory's `.codex/rules` too — and predexec must as well.
 */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let cur = dir; ; cur = dirname(cur)) {
    out.push(cur);
    if (dirname(cur) === cur) return out;
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
function mainWorktreeRoot(cwd: string): string | null {
  for (const dir of ancestors(cwd)) {
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
  /** `project_root_markers`, or undefined when this file does not set it. */
  markers: string[] | undefined;
}

const DEFAULT_PROJECT_ROOT_MARKERS = [".git"];

/**
 * Layer `overlay` over `base` the way Codex merges config layers before
 * deciding trust (config/src/merge.rs merge_toml_values: tables merge per key,
 * a later scalar or array replaces an earlier one). A project key's trust in
 * the higher layer replaces the lower one's; an entry with no trust_level was
 * already dropped, so it leaves the lower layer's trust standing.
 */
function mergeTrustConfigs(base: TrustConfig, overlay: TrustConfig): TrustConfig {
  const byKey = new Map(base.projects.map((p) => [p.key, p] as const));
  for (const project of overlay.projects) byKey.set(project.key, project);
  return { projects: [...byKey.values()], markers: overlay.markers ?? base.markers };
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
  const empty: TrustConfig = { projects: [], markers: undefined };
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
 *   1. system: `<systemDir>/rules` (default `/etc/codex/rules`); its
 *      `<systemDir>/config.toml` is merged under the user config.toml for
 *      trust and project_root_markers
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

  // Trust and project_root_markers come from the system config.toml merged
  // under the user's (config/src/loader/mod.rs load_config_layers_state: the
  // system layer, then the user layer, merged before project_trust_context).
  // Either file existing but unreadable fails closed.
  const systemConfigPath = join(opts.systemDir ?? "/etc/codex", "config.toml");
  const systemConfig = readTrustConfig(systemConfigPath, warnings);
  const configPath = join(codexHome, "config.toml");
  const userConfig = readTrustConfig(configPath, warnings);
  if (systemConfig === null || userConfig === null) {
    if (systemConfig === null) unreadable.push(systemConfigPath);
    if (userConfig === null) unreadable.push(configPath);
    return { rules, unreadable, warnings };
  }
  const config = mergeTrustConfigs(systemConfig, userConfig);
  const markers = config.markers ?? DEFAULT_PROJECT_ROOT_MARKERS;

  const originalCwd = resolve(cwd);
  const canonicalCwd = canonicalPath(cwd);
  const cwdAncestors = ancestors(canonicalCwd);
  const projectRoot =
    markers.length === 0
      ? canonicalCwd
      : (cwdAncestors.find((dir) => markers.some((m) => hasMarker(dir, m))) ?? canonicalCwd);
  const repoRoot = mainWorktreeRoot(canonicalCwd);
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
 * Could a prefix rule match a command run by `head`? Codex tokens are exact
 * (no globs); an alternatives position counts when any alternative could, and
 * the empty pattern matches every command.
 */
function ruleCouldMatchHead(pattern: CodexPatternToken[], head: string): boolean {
  if (pattern.length === 0) return true;
  // A wrapper-led pattern (`["timeout","5",["cat","head"]]`) names its head
  // later; try each alternative index across the list positions.
  const width = Math.max(1, ...pattern.map((tok) => (Array.isArray(tok) ? tok.length : 1)));
  for (let k = 0; k < width; k++) {
    const words = pattern.map((tok) => (Array.isArray(tok) ? tok[Math.min(k, tok.length - 1)] ?? "" : tok));
    if (ruleHeadCouldMatch(words, head, { glob: false })) return true;
  }
  return false;
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
  const restrictive = rules
    .filter((rule) => rule.decision !== "allow")
    .sort((a, b) => SEVERITY[b.decision] - SEVERITY[a.decision]);
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
              const baseForms = rawTokens.length === strippedTokens.length && rawTokens.every((token, i) => token === strippedTokens[i])
                ? [rawTokens]
                : [rawTokens, strippedTokens];
              // Codex matches an absolute-path program by its basename
              // (`/bin/rm x` against `["rm"]`; execpolicy/src/policy.rs:344-370,
              // enabled via `resolve_host_executables` in
              // core/src/exec_policy.rs:373,493). It narrows that to the paths a
              // `host_executable(...)` lists; predexec applies it to every
              // absolute path, which only over-blocks (review I3).
              const tokenForms = [...baseForms];
              for (const toks of baseForms) {
                const head = toks[0];
                if (head?.startsWith("/") && basename(head) !== "") tokenForms.push([basename(head), ...toks.slice(1)]);
              }
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
      // A data-fed operand (`echo .env | xargs cat`) never appears as a token
      // a prefix rule could compare, so any forbidden/prompt rule whose first
      // token could name the receiving command stops it (R1).
      for (const entry of commandsWithUnresolvableOperands(cmd)) {
        const rule = restrictive.find((r) => ruleCouldMatchHead(r.pattern, entry.head));
        if (rule) return describeUnresolvableOperand(entry, `your Codex rule ${formatPattern(rule.pattern)}`);
      }
      return null;
    } catch {
      return "incomplete shell syntax (policy inspection failed)";
    }
  };
}
