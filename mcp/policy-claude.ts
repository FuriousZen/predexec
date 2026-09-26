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
import { existsSync, globSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import {
  escapeRegExp,
  inspectCommandSubstitutionTree,
  lexShellWords,
  splitCommandSegments,
  stripLeadingAssignmentsAndWrappers,
  type Operation,
  type PolicyCheckContext,
  type PolicyVerdict,
  type WrapperInspectionOptions,
} from "../core/index.ts";
import { createGitignoreMatcher, gitignorePatternError } from "./gitignore-match.ts";

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

/** A shell word: its dequoted value and its source spelling. */
interface RawWord {
  value: string;
  raw: string;
}

/** Shell file readers whose operands are read-rule targets (CC-3). */
const SHELL_READERS = new Set([
  "cat", "head", "tail", "less", "more", "sed", "awk", "grep", "rg", "wc", "sort", "uniq",
  "cut", "tr", "nl", "od", "xxd", "file", "stat",
  // Beyond the brief's list: other commands that print or digest a named
  // file. `tee` is deliberately absent — it reads stdin; its FILE args are
  // written, which is Edit's business (and a mutation stop here).
  "diff", "cmp", "base64", "strings", "hexdump", "bat", "jq", "yq",
]);
/** Readers whose first operand is a script/pattern/filter unless one is given by option. */
const SCRIPT_FIRST = new Set(["sed", "awk", "grep", "rg", "jq", "yq"]);
/** yq v4 subcommands that may precede the expression. */
const YQ_SUBCOMMANDS = new Set(["eval", "e", "eval-all", "ea"]);
/** Options taking TWO values; `file` says whether the second is a file the command reads. */
const PAIR_OPTIONS: Record<string, Record<string, { file: boolean }>> = {
  jq: {
    "--arg": { file: false },
    "--argjson": { file: false },
    "--slurpfile": { file: true },
    "--rawfile": { file: true },
  },
};
/** Options whose value is the script/pattern (so no positional script follows). */
const SCRIPT_OPTIONS: Record<string, ReadonlySet<string>> = {
  grep: new Set(["-e", "--regexp"]),
  rg: new Set(["-e", "--regexp"]),
  sed: new Set(["-e", "--expression"]),
};
/** Options whose value is a file the command reads (and which replaces the positional script). */
const FILE_OPTIONS: Record<string, ReadonlySet<string>> = {
  grep: new Set(["-f", "--file"]),
  rg: new Set(["-f", "--file"]),
  sed: new Set(["-f", "--file"]),
  awk: new Set(["-f", "--file"]),
  jq: new Set(["-f", "--from-file"]),
  hexdump: new Set(["-f"]),
  // macOS `base64 -i FILE` reads FILE (GNU's `-i` is a flag; taking the next
  // word as a file there only adds a check).
  base64: new Set(["-i", "--input"]),
};
/** Options that take a separate non-file value, skipped so it is not taken for an operand. */
const VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  grep: new Set(["-m", "-A", "-B", "-C", "--max-count", "--after-context", "--before-context", "--context"]),
  rg: new Set(["-m", "-A", "-B", "-C", "-g", "-t", "-T", "-M", "-j", "--glob", "--type", "--type-not", "--max-count"]),
  awk: new Set(["-F", "-v"]),
  cut: new Set(["-d", "-f", "-c", "-b"]),
  sort: new Set(["-t", "-k"]),
  head: new Set(["-n", "-c"]),
  tail: new Set(["-n", "-c"]),
  od: new Set(["-A", "-t", "-j", "-N"]),
  xxd: new Set(["-l", "-s", "-c", "-g"]),
  diff: new Set(["-U", "-C", "-L", "--label", "-I", "--ignore-matching-lines", "-x", "--exclude"]),
  cmp: new Set(["-i", "-n", "--ignore-initial", "--bytes"]),
  hexdump: new Set(["-n", "-s", "-e"]),
  strings: new Set(["-n", "-t", "--bytes", "--radix"]),
  base64: new Set(["-w", "-b", "--wrap", "--break", "-o", "--output"]),
  bat: new Set(["-l", "-r", "-H", "-m", "--language", "--line-range", "--highlight-line", "--map-syntax", "--theme", "--style"]),
  jq: new Set(["--indent", "--tab-width"]),
  yq: new Set(["-p", "-o", "-I", "--input-format", "--output-format", "--indent"]),
};

const INPUT_REDIRECT_RE = /^\d*<(?!<|&|\()>?(.*)$/s;
const SKIP_NEXT_REDIRECT_RE = /^(?:\d*<<<?-?|\d*>>?|&>>?|\d*>\|)$/;
const OUTPUT_REDIRECT_RE = /^(?:\d*|&)>/;

/**
 * File operands named by a shell command: known readers' operands and every
 * `<` redirect target ("Read and Edit deny rules apply ... to file commands
 * Claude Code recognizes in Bash, such as `cat`, `head`, `tail`, `sed` ... and
 * to the targets of Bash redirections such as ... `< file`").
 *
 * Every clause is inspected — substitution bodies and control-structure
 * bodies included — via core's shared shell inspection. `cd` anywhere makes
 * relative operands unresolvable (the host prompts on "a relative path that
 * follows a `cd` in the same command").
 */
function shellReadOperands(command: string): { operands: RawWord[]; afterCd: boolean; complete: boolean } {
  const inspected = inspectCommandSubstitutionTree(command);
  const operands: RawWord[] = [];
  let afterCd = false;
  for (const text of inspected.commands) {
    for (const line of text.split("\n")) {
      for (const segment of splitCommandSegments(line)) {
        // Keep each word's source spelling: brace expansion must know which
        // braces were quoted or escaped (literal) — the value has lost that.
        const tokens: RawWord[] = lexShellWords(segment).words.map((w) => ({ value: w.value, raw: segment.slice(w.start, w.end) }));
        const words: RawWord[] = [];
        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i]!;
          const input = INPUT_REDIRECT_RE.exec(token.value);
          if (input) {
            const target = input[1] ? { value: input[1], raw: token.raw } : tokens[++i];
            if (target !== undefined) operands.push(target);
          } else if (SKIP_NEXT_REDIRECT_RE.test(token.value)) {
            i++; // heredoc delimiter, here-string word, or output target
          } else if (!OUTPUT_REDIRECT_RE.test(token.value) && !/^\d*<[<&(]/.test(token.value)) {
            words.push(token);
          }
        }
        const values = words.map((w) => w.value);
        const stripped = stripLeadingAssignmentsAndWrappers(values, WRAPPER_OPTIONS);
        // Stripping removes a prefix; map back to the raw words by offset.
        const offset = values.length - stripped.length;
        const argv: RawWord[] = stripped.every((v, i) => v === values[offset + i])
          ? words.slice(offset)
          : stripped.map((value) => ({ value, raw: "\\" })); // unmappable: mark as quoted (fail closed on braces)
        const head = argv[0] === undefined ? "" : basename(argv[0].value);
        if (head === "cd" || head === "pushd") afterCd = true;
        if (SHELL_READERS.has(head)) operands.push(...readerOperands(head, argv.slice(1)));
      }
    }
  }
  return { operands, afterCd, complete: inspected.complete };
}

function readerOperands(head: string, args: readonly RawWord[]): RawWord[] {
  const out: RawWord[] = [];
  // Files named by option (`jq --rawfile NAME FILE`, `grep -f FILE`) are kept
  // apart from positionals so the script/filter shift below never drops one.
  const optionFiles: RawWord[] = [];
  let scriptGiven = false;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    const arg = word.value;
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
    } else if (!endOfOptions && arg.startsWith("-") && arg !== "-") {
      const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
      const pair = PAIR_OPTIONS[head]?.[name];
      if (pair) {
        const value = args[i + 2];
        i += 2;
        if (pair.file && value !== undefined) optionFiles.push(value);
      } else if (SCRIPT_OPTIONS[head]?.has(name)) {
        scriptGiven = true;
        if (inline === undefined) i++;
      } else if (FILE_OPTIONS[head]?.has(name)) {
        scriptGiven = true;
        const value = inline !== undefined ? { value: inline, raw: word.raw } : args[++i];
        if (value !== undefined) optionFiles.push(value);
      } else if (VALUE_OPTIONS[head]?.has(name) && inline === undefined) {
        i++;
      } else if (SCRIPT_FIRST.has(head) && /^-[ef]./.test(arg) && !arg.startsWith("--")) {
        // Attached short forms: `-eexpr`, `-f.env`.
        scriptGiven = true;
        if (arg[1] === "f") optionFiles.push({ value: arg.slice(2), raw: word.raw });
      }
    } else {
      out.push(word);
    }
  }
  if (head === "yq" && YQ_SUBCOMMANDS.has(out[0]?.value ?? "")) out.shift();
  if (SCRIPT_FIRST.has(head) && !scriptGiven) out.shift();
  return [...optionFiles, ...out];
}

/** Most words one operand's brace expansion may produce before it counts as unresolvable. */
const MAX_BRACE_WORDS = 64;
/** Most brace groups expanded (nested or in sequence) within one operand. */
const MAX_BRACE_DEPTH = 4;

/**
 * Bash brace expansion — `{a,b}` lists and `{1..3}` / `{a..c}` sequences — so
 * `cat {.env,x}` cannot slip a denied name past the check. Bounded: null when
 * the expansion exceeds MAX_BRACE_WORDS words or MAX_BRACE_DEPTH groups, and
 * the caller treats the operand as unresolvable. A brace group that is not an
 * expansion (`{}`, `{x}`) is literal, as in bash. Quoting is already stripped
 * by the tokenizer, so a quoted brace is expanded too — that only adds checks.
 */
function expandBraces(word: string, depth = 0): string[] | null {
  for (let open = word.indexOf("{"); open !== -1; open = word.indexOf("{", open + 1)) {
    let nesting = 0;
    let close = -1;
    const commas: number[] = [];
    for (let i = open; i < word.length; i++) {
      const ch = word[i];
      if (ch === "{") nesting++;
      else if (ch === "}" && --nesting === 0) {
        close = i;
        break;
      } else if (ch === "," && nesting === 1) commas.push(i);
    }
    if (close === -1) continue; // an unclosed `{` is literal; later groups still expand (bash)
    const inner = word.slice(open + 1, close);
    let alternatives: string[] | null = null;
    if (commas.length > 0) {
      // Commas inside a nested group belong to it; only depth-1 commas split.
      alternatives = [];
      let start = open + 1;
      for (const comma of [...commas, close]) {
        alternatives.push(word.slice(start, comma));
        start = comma + 1;
      }
    } else {
      const seq = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(inner);
      if (seq) alternatives = braceSequence(seq[1]!, seq[2]!, seq[3]);
      else continue; // literal braces; look for a later group
      if (alternatives === null) return null;
    }
    if (depth >= MAX_BRACE_DEPTH) return null;
    const prefix = word.slice(0, open);
    const suffix = word.slice(close + 1);
    const out: string[] = [];
    for (const alternative of alternatives) {
      const expanded = expandBraces(prefix + alternative + suffix, depth + 1);
      if (expanded === null) return null;
      out.push(...expanded);
      if (out.length > MAX_BRACE_WORDS) return null;
    }
    return out;
  }
  return [word];
}

/**
 * `{a..b[..step]}`. Numeric endpoints written with a leading zero pad every
 * term to the wider endpoint's width, as bash 4+ does (`{01..02}` →
 * `01 02`); a shell that does not pad (bash 3.2) only makes the padded
 * spelling an extra check.
 */
function braceSequence(from: string, to: string, stepText: string | undefined): string[] | null {
  const numeric = /^-?\d+$/.test(from) && /^-?\d+$/.test(to);
  if (!numeric && (/\d/.test(from) || /\d/.test(to))) return null;
  const a = numeric ? Number(from) : from.charCodeAt(0);
  const b = numeric ? Number(to) : to.charCodeAt(0);
  const step = Math.abs(Number(stepText ?? 1)) || 1;
  if (Math.abs(b - a) / step + 1 > MAX_BRACE_WORDS) return null;
  const padded = numeric && [from, to].some((end) => /^-?0\d/.test(end));
  const width = Math.max(from.length, to.length);
  const format = (v: number): string => {
    if (!numeric) return String.fromCharCode(v);
    if (!padded) return String(v);
    const digits = String(Math.abs(v)).padStart(width - (v < 0 ? 1 : 0), "0");
    return v < 0 ? `-${digits}` : digits;
  };
  const out: string[] = [];
  for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) out.push(format(v));
  return out;
}

/**
 * Resolve one shell operand to absolute paths, or a reason it cannot be
 * resolved. Brace expansion runs only when the word's source spelling has no
 * quoting or escaping: a quoted/escaped brace is literal in bash, and once the
 * tokenizer has removed the quotes the two are indistinguishable — so a word
 * with braces AND quoting is unresolvable (fail closed) rather than guessed.
 */
function resolveShellOperand(word: RawWord, cwd: string, home: string, afterCd: boolean): string[] | { unresolved: string } {
  const operand = word.value;
  if (operand === "-" || operand === "") return [];
  if (/[$`]/.test(operand)) return { unresolved: operand };
  if (/[{}]/.test(operand)) {
    if (/['"\\]/.test(word.raw)) return { unresolved: word.raw };
    const words = expandBraces(operand);
    if (words === null) return { unresolved: operand };
    if (words.length > 1 || words[0] !== operand) {
      const out: string[] = [];
      for (const expanded of words) {
        const resolved = resolveShellOperand({ value: expanded, raw: expanded }, cwd, home, afterCd);
        if (!Array.isArray(resolved)) return { unresolved: operand };
        out.push(...resolved);
      }
      return out;
    }
  }
  let path = operand;
  if (path === "~" || path.startsWith("~/")) path = join(home, path.slice(1));
  else if (path.startsWith("~")) return { unresolved: operand };
  if (afterCd && !isAbsolute(path)) return { unresolved: operand };
  if (/[*?[]/.test(path)) {
    // Expand the glob ourselves so `cat .en*` cannot slip past `Read(./.env)`.
    // `**` is recursive (zsh) and unbounded — refuse rather than walk it.
    if (path.includes("**")) return { unresolved: operand };
    try {
      const matches = globSync(path, { cwd });
      if (matches.length > 1000) return { unresolved: operand };
      return [resolve(cwd, path), ...matches.map((m) => resolve(cwd, m))];
    } catch {
      return { unresolved: operand };
    }
  }
  return [resolve(cwd, path)];
}

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
        const { operands, afterCd, complete } = shellReadOperands(shell);
        const targets: ReadTarget[] = [];
        for (const operand of operands) {
          const resolved = resolveShellOperand(operand, cwd, home, afterCd);
          if (!Array.isArray(resolved)) {
            return `unresolvable shell read operand '${resolved.unresolved}' (Read rules are in effect; name the file literally)`;
          }
          for (const path of resolved) targets.push({ path, searchRoot: true });
        }
        const hit = matchTargets(compiled, "shell", targets);
        if (hit) return hit;
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
    .sort((a, b) => (a.action === b.action ? 0 : a.action === "deny" ? -1 : 1));
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
      return null;
    } catch {
      return "incomplete shell syntax (policy inspection failed)";
    }
  };
}
