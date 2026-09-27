/**
 * predexec policy — Claude Code host-permission reader/checker (MCP adapter).
 *
 * Harness-facing (NOT part of pure `core/`): fs + env access lives here, like
 * policy.ts/steering.ts/stats.ts. Same hole as opencode's, but wider: an MCP
 * server is a separate process, so a shell string predexec spawns is not
 * filtered by the user's `Bash(...)` rules at all. Verified verbatim —
 * "Read and Edit deny rules apply to Claude's built-in file tools and to file
 * commands Claude Code recognizes in Bash… They don't apply to arbitrary
 * subprocesses that read or write files indirectly" (permissions.md). MCP tools
 * are permissioned at the granularity of `mcp__predexec__predexec`, not at the
 * granularity of what that tool does inside. Without this module predexec is a
 * permission-laundering path: a user who wrote `deny: ["Bash(curl *)"]` would
 * find predexec running curl anyway.
 *
 * So predexec reads Claude Code's own settings and hard-stops (`policyStop`)
 * BEFORE running any command a deny OR ask rule would have caught — predexec
 * cannot prompt mid-walk, so a would-be prompt is a stop. The standing rule:
 * strictly MORE conservative than the host, never less. Every judgement call
 * below resolves in that direction.
 *
 * PRECEDENCE DIFFERS FROM policy.ts — read this before assuming they match.
 * opencode evaluates rules last-matching-wins, so a later `allow` genuinely
 * rescues a command an earlier `deny` caught. Claude Code does not: "Rules are
 * evaluated in order: deny, then ask, then allow. The first match in that order
 * determines the outcome, and rule specificity doesn't change the order."
 * So allow rules are parsed (they belong in the rule list a caller inspects)
 * but the checker never consults them — nothing widens what predexec will run.
 * Deny/ask are restrictive-only and therefore apply regardless of workspace
 * trust, which is why an untrusted workspace changes nothing here.
 *
 * Because a deny/ask at ANY scope stops us, the settings chain is a union
 * rather than an override cascade. That is what makes the messy parts cheap:
 * reading a stale cwd-local settings file alongside the repo-root one, or a
 * managed drop-in directory, can only ever add stops.
 *
 * Reads are exception-safe, but a settings file that EXISTS and fails to parse
 * is treated as unknown → stop, not as absent → allow, exactly as policy.ts
 * does. An unreadable policy is when guessing "allow" is least defensible.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import {
  commandsWithUnresolvableOperands,
  describeUnresolvableOperand,
  escapeRegExp,
  inspectCommandSubstitutionTree,
  operandHeadMayReadPaths,
  ruleHeadCouldMatch,
  tokenizeShellWords,
  splitCommandSegments,
  stripLeadingAssignmentsAndWrappers,
  type Operation,
  type PolicyCheckContext,
  type PolicyVerdict,
  type WrapperInspectionOptions,
} from "../core/index.ts";
import { createGitignoreMatcher, gitignorePatternError } from "./gitignore-match.ts";
import { resolveShellPathOperands } from "./shell-path-operands.ts";

export type ClaudePolicyAction = "allow" | "ask" | "deny";

/**
 * The verdict every host-policy checker returns: core's `PolicyVerdict`,
 * re-exported so `policy-codex.ts`'s existing import keeps working.
 */
export type { PolicyVerdict };

export interface ClaudePolicyRule {
  /** The bash-command glob, with `Bash(...)` and the `:*` alias normalized away. */
  pattern: string;
  action: ClaudePolicyAction;
}

export interface ClaudeOperationPolicyRule {
  /**
   * `read` (a `Read` rule) governs every file op and shell reads — "Claude
   * makes a best-effort attempt to apply `Read` rules to all built-in tools
   * that read files like Grep and Glob" and "to file commands Claude Code
   * recognizes in Bash" (permissions docs). `grep`/`find` are the host's
   * `Grep(...)`/`Glob(...)` path rules, which the host accepts but never
   * consults; predexec honors them for their own op only, which is stricter.
   */
  tool: "read" | "grep" | "find" | "*";
  /** The rule's path pattern, as written inside the parentheses. */
  pattern: string;
  action: ClaudePolicyAction;
  /** A bare tool name (`Read`, `Grep`, `Glob`, `*`): matches every path, not a gitignore `*`. */
  wholeTool?: boolean;
  /** Settings file the rule came from: a `!` carve-out reaches only rules from the same source. */
  source?: string;
  /** Where a leading-`/` pattern anchors. Omitted = the project directory. */
  settingsDirs?: string[];
}

export interface ClaudePolicyOptions {
  /** Env to read `CLAUDE_CONFIG_DIR` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Managed-settings directory override. Tests cannot write to `/etc`. */
  managedDir?: string;
  /** Home directory override (for `~/` rules and the default config dir). Defaults to `os.homedir()`. */
  home?: string;
  /** Managed-policy presence probe override; defaults to `detectManagedPolicySources()`. */
  managedPolicySources?: () => string[];
}

/**
 * Bash tool input parameters, for the `Tool(param:value)` rule form.
 *
 * `Bash(command:rm *)` is the load-bearing one: Claude Code IGNORES it and
 * emits a startup warning, because a compound command would bypass it. Honoring
 * a rule the host does not honor would make predexec stricter-than-AND-
 * different-from the host, which is the one flavour of conservative that just
 * confuses people. The rest constrain a parameter, not command text, so they
 * say nothing about a command string.
 *
 * Note what is deliberately NOT here: `git`. In `Bash(git:* push)` the colon is
 * literal (docs are explicit), so that rule stays a — useless, never-matching —
 * command pattern rather than being parsed as a parameter form.
 */
const BASH_PARAMETERS = new Set(["command", "timeout", "description", "run_in_background"]);

/**
 * Wrappers Claude Code strips before matching Bash rules, so `Bash(npm test *)`
 * also matches `timeout 30 npm test`. We must strip them too, in the same
 * direction: without this, `deny: ["Bash(rm *)"]` would miss `timeout 5 rm -rf
 * tmp` and predexec would run a command the host blocks — less conservative
 * than the host, which is the failure this file exists to prevent.
 *
 * The list is Claude Code's, not core's `WRAPPERS` (a different set for a
 * different job). Environment runners like `npx`/`docker exec` are pointedly
 * absent from the host's list, so they are absent here.
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

const ACTIONS: ClaudePolicyAction[] = ["deny", "ask", "allow"];

/**
 * Strip wrappers and leading assignments the way Claude Code does before
 * matching. Returns the command unchanged when nothing applies.
 *
 * A deny/ask rule "matches past any leading assignment", so `Bash(rm *)` still
 * catches `FOO=bar rm -rf tmp/` — hence the assignment strip runs on every
 * pass, not just the first.
 */
export const stripBashWrappers = (command: string): string =>
  stripLeadingAssignmentsAndWrappers(command, WRAPPER_OPTIONS);

/**
 * Parse one settings file's `permissions` into ordered bash rules.
 *
 * Deny first, then ask, then allow — the order Claude Code evaluates them in,
 * so the pattern reported for a stop is the deny that caught it when both a
 * deny and an ask match. Non-Bash entries (`Read(./.env)`, `WebFetch(...)`) are
 * skipped: they gate tools this checker does not speak for.
 * Throws on malformed JSON so the caller can fail closed. Claude Code settings
 * are strict JSON — no comment stripping, unlike opencode's `.jsonc`.
 */
export function parseClaudeBashRules(settingsText: string): ClaudePolicyRule[] {
  const settings = JSON.parse(settingsText) as { permissions?: unknown };
  const permissions = settings?.permissions;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) return [];

  const rules: ClaudePolicyRule[] = [];
  for (const action of ACTIONS) {
    const entries = (permissions as Record<string, unknown>)[action];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      const pattern = bashPatternFromEntry(entry, action);
      if (pattern !== null) rules.push({ pattern, action });
    }
  }
  return rules;
}

/** Parse the documented Claude native Read, Grep, and Glob permission entries. */
export function parseClaudeOperationRules(settingsText: string): ClaudeOperationPolicyRule[] {
  const settings = JSON.parse(settingsText) as { permissions?: unknown };
  const permissions = settings?.permissions;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) return [];
  const out: ClaudeOperationPolicyRule[] = [];
  for (const action of ACTIONS) {
    const entries = (permissions as Record<string, unknown>)[action];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      const open = entry.indexOf("(");
      if (open === -1) {
        const bare = entry.trim();
        if (bare === "*") out.push({ tool: "*", pattern: "*", action, wholeTool: true });
        else if (bare === "Read") out.push({ tool: "read", pattern: "*", action, wholeTool: true });
        else if (bare === "Grep") out.push({ tool: "grep", pattern: "*", action, wholeTool: true });
        else if (bare === "Glob") out.push({ tool: "find", pattern: "*", action, wholeTool: true });
        continue;
      }
      if (open < 1 || !entry.endsWith(")")) continue;
      const hostTool = entry.slice(0, open).trim();
      const pattern = entry.slice(open + 1, -1).trim();
      if (!pattern || !["Read", "Grep", "Glob", "*"].includes(hostTool)) continue;
      const tool: ClaudeOperationPolicyRule["tool"] = hostTool === "Read" ? "read" : hostTool === "Grep" ? "grep" : hostTool === "Glob" ? "find" : "*";
      out.push({ tool, pattern, action });
    }
  }
  return out;
}

/**
 * Reduce one permission entry to the bash glob it constrains, or null when it
 * says nothing about bash commands.
 *
 * Handles every documented spelling: `Bash(git push *)`, bare `Bash` and
 * `Bash(*)` (equivalent, both mean every command), the ignored parameter form,
 * and — for deny/ask only — a tool-name glob such as `"*"` that matches every
 * tool, Bash included. Skipping bare `Bash` would be the largest possible
 * under-conservatism here: it is the strongest signal a user can send.
 */
function bashPatternFromEntry(entry: string, action: ClaudePolicyAction): string | null {
  const trimmed = entry.trim();
  const open = trimmed.indexOf("(");

  if (open === -1 || !trimmed.endsWith(")")) {
    // Bare tool name, or a tool-name glob. Allow-rule globs are anchored to an
    // `mcp__<server>__` prefix by the host and never auto-approve bash, so only
    // deny/ask are considered; `mcp__*` must NOT stop bash.
    if (trimmed === "Bash") return "*";
    if (action !== "allow" && trimmed.includes("*")) {
      const regex = patternToRegex(trimmed);
      return regex?.test("Bash") ? "*" : null;
    }
    return null;
  }

  if (trimmed.slice(0, open).trim() !== "Bash") return null;
  const inner = trimmed.slice(open + 1, -1).trim();
  if (inner === "" || inner === "*") return "*";

  // Parameter form — `Bash(command:rm *)` and friends. Whitespace around the
  // colon is ignored by the host, so it is ignored here too.
  const colon = inner.indexOf(":");
  if (colon > 0 && !(colon === inner.length - 2 && inner.endsWith(":*"))) {
    const name = inner.slice(0, colon).trim();
    if (BASH_PARAMETERS.has(name)) return null;
  }
  return inner;
}

/**
 * Compile a Claude Code bash pattern to an anchored regex.
 *
 * Four shapes, and the differences between them are the whole point:
 *   `ls *`  → word boundary, trailing args OPTIONAL: matches `ls -la` and bare
 *             `ls` ("requiring the prefix to be followed by a space or
 *             end-of-string"), but never `lsof`.
 *   `ls:*`  → alias for `ls *`, recognized ONLY at the end of a pattern; in
 *             `git:* push` the colon is a literal character.
 *   `ls*`   → no boundary: matches `ls -la` AND `lsof`.
 *   `git * main` / `* install` → a mid or leading `*` is a plain wildcard
 *             spanning any characters, spaces included.
 *
 * Compiling `ls *` as `^ls .*$` — the obvious reading — misses bare `ls`, and
 * a missed deny is a command predexec runs that the host would have blocked.
 */
function patternToRegex(pattern: string): RegExp | null {
  try {
    let body = pattern.endsWith(":*") ? `${pattern.slice(0, -2)} *` : pattern;
    let tail = "";
    if (body.endsWith(" *")) {
      body = body.slice(0, -2);
      tail = "(?: [\\s\\S]*)?";
    }
    const escaped = escapeRegExp(body).replace(/\\\*/g, "[\\s\\S]*");
    return new RegExp(`^${escaped}${tail}$`);
  } catch {
    return null;
  }
}

/** The git repository root for `dir`, or null when there is no repo above it. */
function findRepoRoot(dir: string): string | null {
  const root = parsePath(dir).root;
  let current = dir;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current || current === root) return null;
    current = parent;
  }
}

/**
 * The main checkout backing a linked worktree, or null.
 *
 * Claude Code resolves `settings.local.json` "through worktrees to the main
 * checkout". In a linked worktree `.git` is a FILE holding
 * `gitdir: /path/to/main/.git/worktrees/<name>`, so the main checkout is
 * readable with plain fs — no `git` subprocess, which keeps this module
 * side-effect free and testable.
 */
function mainCheckoutOf(repoRoot: string): string | null {
  try {
    const dotGit = join(repoRoot, ".git");
    if (statSync(dotGit).isDirectory()) return null;
    const match = /gitdir:\s*(.+)/.exec(readFileSync(dotGit, "utf8"));
    const gitDir = match?.[1]?.trim();
    const marker = gitDir?.indexOf(`${join(".git", "worktrees")}`) ?? -1;
    if (!gitDir || marker <= 0) return null;
    return gitDir.slice(0, marker - 1);
  } catch {
    return null;
  }
}

/** Which scope a settings file belongs to — decides where its `/path` rules anchor. */
export type ClaudeSettingsKind = "remote" | "managed" | "local" | "project" | "user";

export interface ClaudeSettingsSource {
  path: string;
  kind: ClaudeSettingsKind;
  /** Directories a leading-`/` Read pattern in this file anchors at. */
  settingsDirs: string[];
}

/**
 * Every settings file Claude Code would consult, in the documented precedence
 * order (remote → managed → local project → project → user).
 *
 * The order is documentation, not behavior: deny/ask from any scope stops us,
 * so the checker unions them. That is also why the list is generous —
 * `managed-settings.d/` drop-ins, the repo root AND the main checkout AND the
 * cwd copy of `settings.local.json` (pre-v2.1.211 left one behind, and the
 * host keeps "permission rules from both files in effect"). Each extra file can
 * only add stops.
 *
 * `remote-settings.json` is the on-disk cache of server-managed settings —
 * "A startup that runs on the cache at `~/.claude/remote-settings.json`"
 * (https://code.claude.com/docs/en/server-managed-settings). It lives in the
 * config dir, so `CLAUDE_CONFIG_DIR` relocates it with `settings.json`.
 *
 * `/path` anchors, per https://code.claude.com/docs/en/permissions ("A `/path`
 * pattern anchors at a directory associated with the settings source"):
 * project and local settings → the primary working directory; user settings →
 * the config dir. The docs do not say where a managed or remote-cache `/path`
 * anchors, so those anchor at BOTH the project dir and the file's own dir —
 * two bases can only add stops.
 *
 * Not representable: the host's `--allowedTools`/`--disallowedTools` CLI flags.
 * A subprocess cannot see them, so a CLI-only deny is a hole predexec cannot
 * close. MDM plists and registry policies are detected by presence only; see
 * `detectManagedPolicySources`.
 */
export function claudeSettingsSources(projectDir: string, opts: ClaudePolicyOptions = {}): ClaudeSettingsSource[] {
  const env = opts.env ?? process.env;
  const sources: ClaudeSettingsSource[] = [];
  // CLAUDE_CONFIG_DIR relocates the user config dir ("set CLAUDE_CONFIG_DIR;
  // Claude Code then stores your settings ... there instead" — settings docs).
  const configDir = env.CLAUDE_CONFIG_DIR || join(opts.home ?? homedir(), ".claude");

  sources.push({ path: join(configDir, "remote-settings.json"), kind: "remote", settingsDirs: [projectDir, configDir] });

  const managedDir = opts.managedDir ?? defaultManagedDir();
  const managedDirs = [projectDir, managedDir];
  sources.push({ path: join(managedDir, "managed-settings.json"), kind: "managed", settingsDirs: managedDirs });
  try {
    const dropIn = join(managedDir, "managed-settings.d");
    for (const name of readdirSync(dropIn).sort()) {
      if (name.endsWith(".json")) sources.push({ path: join(dropIn, name), kind: "managed", settingsDirs: managedDirs });
    }
  } catch {
    // Absent drop-in dir is the normal case, not an error.
  }

  // `.claude/settings.local.json` lives at the git repository root since
  // v2.1.211, not in the directory Claude Code was started from. Its rules
  // still anchor at the primary working directory.
  const repoRoot = findRepoRoot(projectDir);
  const localRoots = new Set<string>();
  if (repoRoot) {
    localRoots.add(repoRoot);
    const mainCheckout = mainCheckoutOf(repoRoot);
    if (mainCheckout) localRoots.add(mainCheckout);
  }
  localRoots.add(projectDir);
  for (const dir of localRoots) {
    sources.push({ path: join(dir, ".claude", "settings.local.json"), kind: "local", settingsDirs: [projectDir] });
  }

  sources.push({ path: join(projectDir, ".claude", "settings.json"), kind: "project", settingsDirs: [projectDir] });
  sources.push({ path: join(configDir, "settings.json"), kind: "user", settingsDirs: [configDir] });
  return sources;
}

/** The settings file paths of `claudeSettingsSources`, in the same order. */
export function claudeSettingsPaths(projectDir: string, opts: ClaudePolicyOptions = {}): string[] {
  return claudeSettingsSources(projectDir, opts).map((source) => source.path);
}

function defaultManagedDir(): string {
  switch (platform()) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode";
    case "win32":
      return "C:\\Program Files\\ClaudeCode";
    default:
      return "/etc/claude-code";
  }
}

/**
 * Read bash rules across every settings file Claude Code would consult.
 *
 * `unreadable` reports files that exist but failed to parse; the caller fails
 * closed on those. A settings file we cannot read is the worst possible moment
 * to assume "allow".
 */
export function readClaudeBashRules(
  projectDir: string,
  opts: ClaudePolicyOptions = {},
): { rules: ClaudePolicyRule[]; unreadable: string[] } {
  const rules: ClaudePolicyRule[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  for (const path of claudeSettingsPaths(projectDir, opts)) {
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      rules.push(...parseClaudeBashRules(readFileSync(path, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(path);
    }
  }
  return { rules, unreadable };
}

export function readClaudeOperationRules(
  projectDir: string,
  opts: ClaudePolicyOptions = {},
): { rules: ClaudeOperationPolicyRule[]; unreadable: string[] } {
  const rules: ClaudeOperationPolicyRule[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  for (const source of claudeSettingsSources(projectDir, opts)) {
    if (seen.has(source.path)) continue;
    seen.add(source.path);
    try {
      for (const rule of parseClaudeOperationRules(readFileSync(source.path, "utf8"))) {
        rules.push({ ...rule, source: source.path, settingsDirs: source.settingsDirs });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(source.path);
    }
  }
  return { rules, unreadable };
}

// ---------------------------------------------------------------------------
// Read rules: gitignore path semantics (CC-2), shell readers (CC-3).
//
// Authority: https://code.claude.com/docs/en/permissions, "Read and Edit".
// "Read and Edit rules both use gitignore pattern syntax with four distinct
// pattern types": `//path` (filesystem root), `~/path` (home), `/path` (the
// settings source), `path` / `./path` (the current directory). Only deny/ask
// rules are compiled — allow never widens what predexec runs — so the
// deny/ask depth rule applies: "`Read(secrets/**)` matches a directory named
// `secrets` at any depth under the current directory".
// ---------------------------------------------------------------------------

/** Where Claude path rules anchor. `settingsDir` is the `/path` base for the rule's settings file. */
export interface ClaudePathAnchor {
  projectDir: string;
  settingsDir: string;
  home: string;
}

/** A compiled path test: `isDir` unknown (undefined) is checked both ways, so it can only add matches. */
type PathTest = (absPath: string, isDir?: boolean) => boolean;

/** A child name no real path segment can contain: "does this rule cover the directory's contents?" */
const ANY_CHILD = "\u0000predexec-any-child";

/**
 * Compile one Claude Read/Edit path pattern (the text inside `Read(...)`) with
 * deny/ask semantics into an absolute-path test. See `compileClaudePathRules`.
 */
export function compileClaudePathRule(rule: string, anchor: ClaudePathAnchor): PathTest {
  const { test } = compileClaudePathRules([rule], [anchor.settingsDir], anchor.projectDir, anchor.home);
  return (absPath, isDir) => test(absPath, isDir) !== null;
}

/**
 * Compile one settings file's ordered Read patterns (deny/ask semantics) into a
 * test returning the pattern that matched, or null.
 *
 * `!` carve-outs: "A deny or ask pattern that starts with `!` is a gitignore
 * negation. It carves the paths it matches out of the `path` or `./path`
 * rules listed before it" — so relative rules and negations form ONE ordered
 * gitignore list, and anchored (`//`, `~/`, `/`) rules stand alone. "Claude
 * Code reads a `!` pattern relative to the current directory even when `/`,
 * `~/`, or `//` follows the `!`, so the pattern can't reach a rule anchored
 * with one of those prefixes"; a `!~/…` or `!//…` is dropped outright, which
 * carves nothing — the conservative reading.
 *
 * `error` names the first pattern that is not a usable gitignore pattern (a
 * reversed range, an unknown POSIX class). The caller fails closed on it:
 * guessing what a broken deny rule meant to protect is the wrong default.
 */
function compileClaudePathRules(
  patterns: readonly string[],
  settingsDirs: readonly string[],
  projectDir: string,
  home: string,
): { test: (absPath: string, isDir?: boolean) => string | null; error: string | null } {
  const standalone: { label: string; test: PathTest }[] = [];
  const relativeLines: string[] = [];
  const relativeRules: { label: string; line: string }[] = [];
  let error: string | null = null;
  const screen = (raw: string, line: string): void => {
    const why = error === null ? gitignorePatternError(line) : null;
    if (why) {
      error =
        `cannot parse Claude Code Read rule '${raw}' (${why}) — ` +
        `predexec stops rather than guess what it protects; fix that rule to continue`;
    }
  };

  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern.startsWith("!")) {
      const rest = pattern.slice(1);
      if (rest.startsWith("~") || rest.startsWith("//")) continue;
      const line = `!${rest.startsWith("./") ? `/${rest.slice(2)}` : rest}`;
      screen(raw, line);
      relativeLines.push(line);
      continue;
    }
    const anchored = anchoredForm(pattern, settingsDirs, home);
    if (anchored) {
      for (const { line } of anchored) screen(raw, line);
      const tests = anchored.flatMap(({ base, line }) => withRealPrefix(base, line)).map(({ base, line }) =>
        underBases([base], createGitignoreMatcher([line])),
      );
      standalone.push({ label: raw, test: (abs, isDir) => tests.some((t) => t(abs, isDir)) });
      continue;
    }
    const line = relativeLine(pattern);
    screen(raw, line);
    relativeLines.push(line);
    relativeRules.push({ label: raw, line });
  }

  const projectBases = uniqueRealBases([projectDir]);
  const list = underBases(projectBases, createGitignoreMatcher(relativeLines));
  const singles = relativeRules.map(({ label, line }) => ({ label, test: underBases(projectBases, createGitignoreMatcher([line])) }));

  const test = (absPath: string, isDir?: boolean): string | null => {
    for (const rule of standalone) if (rule.test(absPath, isDir)) return rule.label;
    if (singles.length > 0 && list(absPath, isDir)) {
      // The list decided "matched"; name the first positive rule that matches on its own.
      return singles.find((rule) => rule.test(absPath, isDir))?.label ?? singles[0]!.label;
    }
    return null;
  };
  return { test, error };
}

/** `//x`, `~/x`, `/x` → (base, anchored gitignore line)s, or null for a project-relative pattern. */
function anchoredForm(pattern: string, settingsDirs: readonly string[], home: string): { base: string; line: string }[] | null {
  if (pattern.startsWith("//")) return [{ base: "/", line: `/${pattern.replace(/^\/+/, "")}` }];
  if (pattern === "~") return [{ base: home, line: "**" }];
  if (pattern.startsWith("~/")) return [{ base: home, line: `/${pattern.slice(2)}` }];
  if (pattern.startsWith("/")) return settingsDirs.map((base) => ({ base, line: pattern }));
  return null;
}

/** `./x` anchors at the project dir; a bare single-segment `dir/**` matches that dir at any depth (deny/ask). */
function relativeLine(pattern: string): string {
  if (pattern.startsWith("./")) return `/${pattern.slice(2)}`;
  if (/^[^/]+\/\*\*$/.test(pattern)) return `**/${pattern}`;
  return pattern;
}

/**
 * "A deny or ask rule written through a symlinked directory with a `//`,
 * `~/`, or `/` pattern also applies at the directory's real location" — e.g.
 * `Read(//etc/**)` blocks `/private/etc/hosts` on macOS. Add a variant based at
 * the realpath of the pattern's leading literal directories.
 */
function withRealPrefix(base: string, line: string): { base: string; line: string }[] {
  const out = uniqueRealBases([base]).map((b) => ({ base: b, line }));
  const segments = line.replace(/^\/+/, "").split("/");
  const literal: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (/[*?[\\]/.test(segment)) break;
    literal.push(segment);
  }
  if (literal.length > 0) {
    const dir = join(base, ...literal);
    const real = realpathLoose(dir);
    if (real !== dir) out.push({ base: real, line: `/${segments.slice(literal.length).join("/")}` });
  }
  return out;
}

function uniqueRealBases(bases: readonly string[]): string[] {
  return [...new Set(bases.flatMap((b) => [b, realpathLoose(b)]))];
}

/** Test `matcher` against `absPath` relative to each base; paths outside a base never match it. */
function underBases(bases: readonly string[], matcher: (rel: string, isDir?: boolean) => boolean): PathTest {
  return (absPath, isDir) =>
    bases.some((base) => {
      const rel = relative(base, absPath);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
      const posix = sep === "\\" ? rel.split(sep).join("/") : rel;
      return isDir === undefined ? matcher(posix, true) || matcher(posix, false) : matcher(posix, isDir);
    });
}

/** realpath, or — for a path that does not exist — the realpath of its nearest existing ancestor plus the rest. */
function realpathLoose(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (let i = 0; i < 256; i++) {
    try {
      return join(realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
  return path;
}

/** Symlink rule: "Deny rules: apply when either the symlink path or its target matches." */
function pathSpellings(absPath: string): { paths: string[]; isDir: boolean | undefined } {
  let isDir: boolean | undefined;
  try {
    isDir = statSync(absPath).isDirectory();
  } catch {
    isDir = undefined;
  }
  return { paths: [...new Set([absPath, realpathLoose(absPath)])], isDir };
}

type ReadTarget = { path: string; searchRoot: boolean };
type OpKind = "read" | "grep" | "find" | "shell";

interface CompiledReadRule {
  tool: ClaudeOperationPolicyRule["tool"];
  action: ClaudePolicyAction;
  test: (absPath: string, isDir?: boolean) => string | null;
  /** Set when a pattern in the group could not be parsed: every operation stops with this reason. */
  invalid?: string;
}

function ruleApplies(rule: CompiledReadRule, kind: OpKind): boolean {
  return rule.tool === "*" || rule.tool === "read" || rule.tool === kind;
}

function compileReadRules(rules: readonly ClaudeOperationPolicyRule[], projectDir: string, home: string): CompiledReadRule[] {
  const groups = new Map<string, ClaudeOperationPolicyRule[]>();
  const compiled: CompiledReadRule[] = [];
  for (const rule of rules) {
    if (rule.action === "allow") continue;
    if (rule.wholeTool) {
      compiled.push({ tool: rule.tool, action: rule.action, test: () => rule.pattern });
      continue;
    }
    const key = `${rule.source ?? ""}\u0000${rule.action}\u0000${rule.tool}`;
    const group = groups.get(key);
    if (group) group.push(rule);
    else groups.set(key, [rule]);
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    const { test, error } = compileClaudePathRules(group.map((r) => r.pattern), first.settingsDirs ?? [projectDir], projectDir, home);
    compiled.push({ tool: first.tool, action: first.action, test, ...(error ? { invalid: error } : {}) });
  }
  // Deny before ask, so a stop names the deny that caught it.
  return compiled.sort((a, b) => (a.action === b.action ? 0 : a.action === "deny" ? -1 : 1));
}

/** First rule (of those applying to `kind`) matching any target, checking every path spelling. */
function matchTargets(rules: readonly CompiledReadRule[], kind: OpKind, targets: readonly ReadTarget[]): string | null {
  const applicable = rules.filter((rule) => ruleApplies(rule, kind));
  if (applicable.length === 0) return null;
  for (const target of targets) {
    const { paths, isDir } = pathSpellings(target.path);
    for (const path of paths) {
      // The path is model-chosen and gitignore matching is polynomial in its
      // segment count; past a sane bound, stop instead of matching.
      if (path.length > MAX_CHECKED_PATH_LENGTH || path.split(sep).length > MAX_CHECKED_PATH_SEGMENTS) {
        return `path too long to check against Read rules (${path.length} chars) — use a shorter path`;
      }
      for (const rule of applicable) {
        const hit = rule.test(path, isDir) ??
          // A searched directory is a read of its contents: "Claude Code
          // applies Read deny rules to that directory" (Grep and Glob).
          (target.searchRoot && isDir !== false ? rule.test(join(path, ANY_CHILD)) : null);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** Longest path (chars / segments) the Read matcher is asked to check; longer stops. */
const MAX_CHECKED_PATH_LENGTH = 4096;
const MAX_CHECKED_PATH_SEGMENTS = 512;

export interface ClaudeOperationCheckerOptions {
  /** Project dir that relative rules anchor at, when the engine context gives no session root. */
  projectDir?: string;
  /** Home dir for `~/` rules. Defaults to `os.homedir()`. */
  home?: string;
}

/**
 * The Read-rule half of the policy callback: native file ops (read/ls/grep/
 * find) and shell reads.
 *
 * Tool-op paths arrive session-root-relative (the engine normalizes them), so
 * they resolve against `sessionRoot`; shell operands resolve against the
 * node's `cwd`. Both the resolved path and its realpath are checked — "A
 * symlink that points to a denied file is itself denied" — and deny wins when
 * the two spellings disagree.
 */
export function createClaudeOperationPolicyChecker(
  rules: ClaudeOperationPolicyRule[],
  unreadable: string[] = [],
  opts: ClaudeOperationCheckerOptions = {},
): (operation: Operation, ctx?: PolicyCheckContext) => PolicyVerdict {
  if (unreadable.length > 0) {
    const why =
      `cannot read your Claude Code permission rules (${unreadable[0]} is not valid JSON) — ` +
      `predexec stops rather than run operations your policy might forbid or prompt on; fix that file to continue`;
    return (operation: Operation) => {
      if (typeof operation === "object" && (operation.tool === "read" || operation.tool === "ls" || operation.tool === "grep" || operation.tool === "find")) return why;
      return null;
    };
  }
  const home = opts.home ?? homedir();
  const cache = new Map<string, CompiledReadRule[]>();
  const compiledFor = (projectDir: string): CompiledReadRule[] => {
    let compiled = cache.get(projectDir);
    if (!compiled) {
      compiled = compileReadRules(rules, projectDir, home);
      cache.set(projectDir, compiled);
    }
    return compiled;
  };

  return (operation: Operation, ctx?: PolicyCheckContext) => {
    const projectDir = ctx?.sessionRoot ?? opts.projectDir ?? process.cwd();
    const compiled = compiledFor(projectDir);
    if (compiled.length === 0) return null;
    const invalid = compiled.find((rule) => rule.invalid !== undefined)?.invalid;
    if (invalid) return invalid;

    const shell = typeof operation === "string"
      ? operation
      : operation.tool === "bash" && typeof operation.command === "string" ? operation.command : null;
    if (shell !== null) {
      if (!compiled.some((rule) => ruleApplies(rule, "shell"))) return null;
      const cwd = ctx?.cwd ?? projectDir;
      try {
        const { paths, directPaths, unresolved, complete } = resolveShellPathOperands(shell, { cwd, root: projectDir, home, wrapperOptions: WRAPPER_OPTIONS });
        if (unresolved !== null) {
          return `unresolvable shell read operand '${unresolved}' (Read rules are in effect; name the file literally)`;
        }
        const targets: ReadTarget[] = [
          ...paths.map((path) => ({ path, searchRoot: true })),
          ...directPaths.map((path) => ({ path, searchRoot: false })),
        ];
        const hit = matchTargets(compiled, "shell", targets);
        if (hit) return hit;
        // `xargs cat` names no operand at all; a Read rule cannot see what it reads.
        const fed = commandsWithUnresolvableOperands(shell).find((entry) => operandHeadMayReadPaths(entry.head));
        if (fed) return describeUnresolvableOperand(fed, "your Claude Code Read rules");
        return complete ? null : "incomplete shell syntax (Read-rule inspection budget exceeded)";
      } catch {
        return "incomplete shell syntax (Read-rule inspection failed)";
      }
    }

    if (typeof operation === "string") return null;
    const kind: OpKind | null = operation.tool === "read" || operation.tool === "ls"
      ? "read"
      : operation.tool === "grep" ? "grep" : operation.tool === "find" ? "find" : null;
    if (!kind) return null;
    const base = resolve(projectDir, typeof operation.path === "string" ? operation.path : ".");
    const targets: ReadTarget[] = [{ path: base, searchRoot: operation.tool !== "read" }];
    if (operation.tool === "find" && typeof operation.pattern === "string") {
      // Kept from the pre-gitignore checker: the requested name under the root.
      targets.push({ path: resolve(base, operation.pattern), searchRoot: false });
    }
    return matchTargets(compiled, kind, targets);
  };
}

// ---------------------------------------------------------------------------
// Managed policy that predexec cannot read (CC-4).
// ---------------------------------------------------------------------------

const MDM_PLIST = "com.anthropic.claudecode.plist";
const REGISTRY_KEYS = ["HKLM\\SOFTWARE\\Policies\\ClaudeCode", "HKCU\\SOFTWARE\\Policies\\ClaudeCode"];

export interface ManagedPolicyDetectionOptions {
  platform?: NodeJS.Platform;
  /** macOS managed-preferences root. Defaults to `/Library/Managed Preferences`. */
  managedPreferencesDir?: string;
  /** macOS user for the per-user profile path. Defaults to the current user. */
  user?: string;
  /** Windows: does `key` hold a `Settings` value? Defaults to `reg query`. */
  registryHasValue?: (key: string) => boolean;
  /**
   * Cache registry answers per process (per probe function). Defaults to true
   * for the built-in `reg query` probe — `createClaudeHostPolicyChecker` runs
   * on every tool call and each probe spawns a subprocess — and false for an
   * injected probe.
   */
  cacheRegistry?: boolean;
}

/** Per-process registry answers, keyed by probe function then registry key. */
const registryCache = new WeakMap<(key: string) => boolean, Map<string, boolean>>();

/**
 * Managed-policy sources that exist but that predexec cannot parse: the macOS
 * `com.anthropic.claudecode` managed-preferences domain (a binary plist) and
 * the Windows `Settings` value under `HKLM`/`HKCU\SOFTWARE\Policies\ClaudeCode`
 * (https://code.claude.com/docs/en/managed-settings, "Where each mechanism
 * stores the policy"). Presence only: reading them would need a plist parser
 * or a registry reader, so a present source makes the caller fail closed.
 * Other platforms have no such source and return [].
 */
export function detectManagedPolicySources(opts: ManagedPolicyDetectionOptions = {}): string[] {
  const os = opts.platform ?? platform();
  if (os === "darwin") {
    const root = opts.managedPreferencesDir ?? "/Library/Managed Preferences";
    let user = opts.user;
    if (user === undefined) {
      try {
        user = userInfo().username;
      } catch {
        user = undefined;
      }
    }
    const candidates = [join(root, MDM_PLIST), ...(user ? [join(root, user, MDM_PLIST)] : [])];
    return candidates.filter((path) => existsSync(path));
  }
  if (os === "win32") {
    const probe = opts.registryHasValue ?? registryHasSettingsValue;
    if (!(opts.cacheRegistry ?? opts.registryHasValue === undefined)) return REGISTRY_KEYS.filter((key) => probe(key));
    let cache = registryCache.get(probe);
    if (!cache) registryCache.set(probe, (cache = new Map()));
    const known = cache;
    return REGISTRY_KEYS.filter((key) => {
      let has = known.get(key);
      if (has === undefined) known.set(key, (has = probe(key)));
      return has;
    });
  }
  return [];
}

/** `reg query` exits 1 when the key/value is absent; any other failure is treated as present (fail closed). */
function registryHasSettingsValue(key: string): boolean {
  try {
    execFileSync("reg", ["query", key, "/v", "Settings"], { stdio: "ignore", timeout: 5000, windowsHide: true });
    return true;
  } catch (err) {
    return (err as { status?: number | null }).status !== 1;
  }
}

/**
 * The full Claude Code host-policy callback the MCP server hands the engine:
 * Bash rules for shell ops, Read rules for file ops and shell reads, and a
 * blanket stop while an unreadable managed (MDM/registry) policy is present.
 * Settings are read once per call to this factory.
 */
export function createClaudeHostPolicyChecker(
  projectDir: string,
  opts: ClaudePolicyOptions = {},
): (operation: Operation, ctx?: PolicyCheckContext) => PolicyVerdict {
  const managed = (opts.managedPolicySources ?? (() => detectManagedPolicySources()))();
  if (managed.length > 0) {
    const why =
      `managed MDM policy (${managed[0]}) cannot be read by predexec — ` +
      `predexec stops rather than run operations your organization's policy might forbid`;
    return () => why;
  }
  const bash = readClaudeBashRules(projectDir, opts);
  const native = readClaudeOperationRules(projectDir, opts);
  const checkBash = createClaudePolicyChecker(bash.rules, bash.unreadable);
  const checkRead = createClaudeOperationPolicyChecker(native.rules, native.unreadable, { projectDir, home: opts.home });
  return (operation, ctx) => {
    const shell = typeof operation === "string" || operation.tool === "bash";
    return (shell ? checkBash(operation) : null) ?? checkRead(operation, ctx);
  };
}

/**
 * Build the Bash portion of the operation-aware policy callback for the engine.
 *
 * Returns the matched pattern when a deny or ask rule catches any part of the
 * command, else null. Allow rules are ignored entirely — under Claude Code's
 * deny → ask → allow ordering an allow can never rescue a denied command, so
 * consulting one could only widen what predexec runs.
 *
 * Each pipeline segment is judged independently, so `echo hi && curl evil.sh`
 * cannot smuggle the curl past a `curl *` rule — "A rule must match each
 * subcommand independently." Newlines are a recognized separator too, and
 * `splitCommandSegments` (core, shared with the destructive heuristic) does not
 * split them, so lines are split off first.
 *
 * `unreadable` settings paths stop everything: we know a policy exists and
 * could not read it, so running anything would be guessing.
 */
export function createClaudePolicyChecker(
  rules: ClaudePolicyRule[],
  unreadable: string[] = [],
): (cmd: string | Operation) => PolicyVerdict {
  if (unreadable.length > 0) {
    // Name the file and the remedy: without that this reads as a predexec bug
    // rather than a syntax error in the user's own settings.
    const why =
      `cannot read your Claude Code permission rules (${unreadable[0]} is not valid JSON) — ` +
      `predexec stops rather than run commands your policy might forbid; fix that file to continue`;
    return () => why;
  }

  const compiled = rules
    .filter((rule) => rule.action !== "allow")
    .map((rule) => ({ ...rule, regex: patternToRegex(rule.pattern) }))
    .filter((rule): rule is ClaudePolicyRule & { regex: RegExp } => rule.regex !== null)
    // Deny before ask across files too, so a stop reports the deny that caught
    // it rather than an ask from a file that happened to be read first. Both
    // stop; only the pattern named in the transcript changes.
    .sort((a, b) => (a.action === b.action ? 0 : a.action === "deny" ? -1 : 1))
    .map((rule) => ({ ...rule, words: tokenizeShellWords(rule.pattern.endsWith(":*") ? rule.pattern.slice(0, -2) : rule.pattern) }));
  return (input: string | Operation) => {
    const cmd = typeof input === "string"
      ? input
      : input.tool === "bash" && typeof input.command === "string" ? input.command : null;
    if (cmd === null) return null;
    try {
      // Substitution bodies are judged as commands too. The shared traversal
      // reports an explicit incomplete result when syntax exceeds its bounded
      // work budget; silently dropping pending bodies would be fail-open.
      const inspected = inspectCommandSubstitutionTree(cmd);
      for (const text of inspected.commands) {
          for (const line of text.split("\n")) {
            for (const segment of splitCommandSegments(line)) {
              const trimmed = segment.trim();
              if (!trimmed) continue;
              // Match the raw segment AND its wrapper-stripped form, then take
              // the union: raw-only misses a `rm *` deny on `timeout 5 rm -rf
              // tmp`, stripped-only misses a `timeout *` deny on the same
              // command.
              const stripped = stripBashWrappers(trimmed);
              const forms = stripped === trimmed ? [trimmed] : [trimmed, stripped];
              const clauseForms = forms;
              for (const rule of compiled) {
                if (clauseForms.some((form) => rule.regex.test(form))) return rule.pattern;
              }
            }
          }
      }
      if (!inspected.complete) {
        return "incomplete shell syntax (policy inspection budget exceeded)";
      }
      // A data-fed operand (`echo .env | xargs cat`) is invisible to a rule
      // matched against command text, so any deny/ask that could match the
      // receiving command stops it (R1).
      for (const entry of commandsWithUnresolvableOperands(cmd)) {
        const rule = compiled.find((r) => ruleHeadCouldMatch(r.words, entry.head));
        if (rule) return describeUnresolvableOperand(entry, `your Claude Code rule Bash(${rule.pattern})`);
      }
      return null;
    } catch {
      return "incomplete shell syntax (policy inspection failed)";
    }
  };
}
