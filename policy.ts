/**
 * predexec policy — opencode host-permission reader/checker, plus the bridge to
 * opencode's own permission service.
 *
 * Harness-facing (NOT part of pure `core/`): fs + env access lives here, like
 * steering.ts/stats.ts. predexec spawns shell strings and runs file ops itself,
 * so without this a user's opencode `permission` rules never see them. The
 * opencode adapter builds a checker per tool call and passes it as
 * `RunOptions.checkOperationPolicy`; the engine hard-stops (`policyStop`)
 * BEFORE running a matched operation.
 *
 * Everything here mirrors opencode v1.18.32 (tag `v1.18.32`, commit 545f51d);
 * the file:line citations below are into that tree.
 *
 * Ruleset: opencode flattens EVERY permission key into one ordered rule list
 * `{permission, pattern, action}` (`permission/index.ts:186-198` fromConfig,
 * `:200-202` merge), matches the rule's KEY as a wildcard against the requested
 * permission as well as its pattern, and takes the LAST match
 * (`permission/index.ts:28-38` evaluate — `findLast`). No match at all is
 * `ask`. So `{bash:"allow","*":"deny"}` denies `ls`: the later `*` key matches
 * `bash` too. Reading only `perm.bash ?? perm["*"]` got that backwards.
 *
 * Layering: config files are combined with remeda `mergeDeep`
 * (`config/config.ts:42-47`), which keeps each key at its FIRST appearance and
 * lets a later file only overwrite its value. Global `{"*":"allow","cat *":"deny"}`
 * + project `{"*":"allow"}` therefore still ends with `cat *` → deny. The agent
 * ruleset is then built-in defaults, the agent's built-in overrides, the user
 * `permission` block, and `agent.<name>.permission` (`agent/agent.ts:119-310`).
 *
 * Both `deny` AND `ask` stop in the STATIC checker: it cannot prompt, and
 * silently running a command the host would have prompted for is the hole
 * being closed. When opencode hands the plugin `context.ask` (the host's real
 * permission service), `createOpencodeAskBridge` lets opencode prompt instead.
 *
 * Reads are exception-safe, but a config that EXISTS and fails to parse (or
 * holds an action opencode's schema rejects) is treated as unknown → stop, not
 * as absent → allow. An unreadable policy is exactly when guessing "allow" is
 * least defensible. opencode itself refuses to start on such a config.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inspectCommandSubstitutionTree, lexShellWords, splitCommandSegments } from "./core/index.ts";
import type { HostPolicyDenial, Operation, PolicyCheckContext, PolicyVerdict } from "./core/types.ts";

export type PolicyAction = "allow" | "ask" | "deny";

/** One flattened opencode rule (`PermissionV1.Rule`). */
export interface PolicyRule {
  /** The permission key, itself a wildcard (`bash`, `read`, `*`, `b*`). */
  permission: string;
  pattern: string;
  action: PolicyAction;
}

/** A readable ruleset, or why the policy could not be read (fail closed). */
export type OpencodeRuleset = PolicyRule[] | { error: string };

type CommandPolicyInspector = (command: string) => { commands: string[]; complete: boolean };

const ACTIONS = new Set<PolicyAction>(["allow", "ask", "deny"]);

const isAction = (v: unknown): v is PolicyAction => typeof v === "string" && ACTIONS.has(v as PolicyAction);

type Json = Record<string, unknown>;

/** remeda 2.26.0's `isPlainObject`: prototype is Object.prototype or null. */
const isPlainObject = (v: unknown): v is Json => {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
};

/**
 * remeda 2.26.0 `mergeDeep` (the version opencode pins, root `package.json`
 * catalog), transcribed from its dist: `{...destination, ...source}`, then
 * recurse where BOTH sides hold a plain object. Spreading keeps every existing
 * key at its first-appearance position — that ordering is load-bearing, since
 * rule order is precedence order.
 */
export function mergeDeep(destination: Json, source: Json): Json {
  const out: Json = { ...destination, ...source };
  for (const key in source) {
    if (!(key in destination)) continue;
    const a = destination[key];
    const b = source[key];
    if (isPlainObject(a) && isPlainObject(b)) out[key] = mergeDeep(a, b);
  }
  return out;
}

/** Strip // and /* *\/ comments so `.jsonc` configs parse. String-aware. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") (inLine = false), (out += c);
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") (inBlock = false), i++;
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") (out += next ?? ""), i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') (inString = true), (out += c);
    else if (c === "/" && next === "/") (inLine = true), i++;
    else if (c === "/" && next === "*") (inBlock = true), i++;
    else out += c;
  }
  return out;
}

/**
 * opencode's `permission` schema (core `v1/config/permission.ts:5-48`): a bare
 * action normalizes to `{"*": action}`; otherwise each key maps to an action
 * or a `{pattern: action}` object. Anything else fails opencode's decode, so it
 * throws here and the caller fails closed.
 */
function normalizePermission(value: unknown, where: string): Json | undefined {
  if (value === undefined) return undefined;
  if (isAction(value)) return { "*": value };
  if (!isPlainObject(value)) throw new Error(`${where}: permission must be an action or an object`);
  for (const [key, rule] of Object.entries(value)) {
    if (isAction(rule)) continue;
    if (!isPlainObject(rule)) throw new Error(`${where}: permission.${key} is not a valid rule`);
    for (const [pattern, action] of Object.entries(rule)) {
      if (!isAction(action)) throw new Error(`${where}: permission.${key}["${pattern}"] is not allow/ask/deny`);
    }
  }
  return value;
}

/** Parse one config text the way opencode decodes it, permission shapes normalized. */
export function parseOpencodeConfig(text: string, where = "config"): Json {
  // `config/config.ts:256` — an empty file is an empty config.
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(stripJsonComments(text));
  if (!isPlainObject(parsed)) throw new Error(`${where}: config must be a JSON object`);
  const config: Json = { ...parsed };
  const permission = normalizePermission(config.permission, where);
  if (permission !== undefined) config.permission = permission;
  // `agent.<name>` and `mode.<name>` entries carry their own permission blocks.
  for (const section of ["agent", "mode"] as const) {
    const entries = config[section];
    if (!isPlainObject(entries)) continue;
    const out: Json = {};
    for (const [name, agent] of Object.entries(entries)) {
      out[name] = isPlainObject(agent) && agent.permission !== undefined
        ? { ...agent, permission: normalizePermission(agent.permission, `${where} ${section}.${name}`) }
        : agent;
    }
    config[section] = out;
  }
  return config;
}

/** `permission/index.ts:178-184` — only config-sourced patterns are expanded. */
function expandHome(pattern: string, home: string): string {
  if (pattern.startsWith("~/")) return home + pattern.slice(1);
  if (pattern === "~") return home;
  if (pattern.startsWith("$HOME/")) return home + pattern.slice(5);
  if (pattern.startsWith("$HOME")) return home + pattern.slice(5);
  return pattern;
}

/** `permission/index.ts:186-198` fromConfig: flatten in key order, then pattern order. */
export function rulesFromPermission(permission: unknown, home: string = homedir()): PolicyRule[] {
  const out: PolicyRule[] = [];
  if (!isPlainObject(permission)) return out;
  for (const [key, value] of Object.entries(permission)) {
    if (isAction(value)) {
      out.push({ permission: key, pattern: "*", action: value });
      continue;
    }
    if (!isPlainObject(value)) continue;
    for (const [pattern, action] of Object.entries(value)) {
      if (isAction(action)) out.push({ permission: key, pattern: expandHome(pattern, home), action });
    }
  }
  return out;
}

/**
 * Wildcard match, core `util/wildcard.ts:3-14`: backslashes become `/`, `*` is
 * `.*`, `?` is `.`, and a trailing `" *"` is optional — `"git log *"` matches
 * bare `git log`. Dotall; case-insensitive only on Windows.
 */
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized);
}

/** `permission/index.ts:28-38` evaluate: last rule whose key AND pattern match; none ⇒ ask. */
export function evaluatePermission(permission: string, pattern: string, ruleset: PolicyRule[]): PolicyRule {
  for (let i = ruleset.length - 1; i >= 0; i--) {
    const rule = ruleset[i]!;
    if (wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) return rule;
  }
  return { permission, pattern: "*", action: "ask" };
}

interface OpencodePaths {
  home: string;
  /** xdg-basedir `xdgConfig` + `/opencode` (core `global.ts:13`). */
  config: string;
  /** xdg-basedir `xdgData` + `/opencode` (core `global.ts:11`). */
  data: string;
  /** `os.tmpdir()` + `/opencode` (core `global.ts:15`). */
  tmp: string;
}

function opencodePaths(env: NodeJS.ProcessEnv): OpencodePaths {
  const home = homedir();
  return {
    // core `global.ts:19` — Global.Path.home honors OPENCODE_TEST_HOME.
    home: env.OPENCODE_TEST_HOME || home,
    config: join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode"),
    data: join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode"),
    tmp: join(tmpdir(), "opencode"),
  };
}

/** `config/managed.ts:20-33`. */
function managedConfigDir(env: NodeJS.ProcessEnv): string {
  if (env.OPENCODE_TEST_MANAGED_CONFIG_DIR) return env.OPENCODE_TEST_MANAGED_CONFIG_DIR;
  if (process.platform === "darwin") return "/Library/Application Support/opencode";
  if (process.platform === "win32") return join(env.ProgramData || "C:\\ProgramData", "opencode");
  return "/etc/opencode";
}

/** core `flag/flag.ts:3-6`. */
const truthy = (value: string | undefined): boolean => {
  const v = value?.toLowerCase();
  return v === "true" || v === "1";
};

/** core `fs-util.ts:168-182` `up`: targets per directory, start → stop inclusive, nearest first. */
function up(targets: string[], start: string, stop: string | undefined): string[] {
  const out: string[] = [];
  let current = start;
  for (;;) {
    for (const target of targets) {
      const candidate = join(current, target);
      if (existsSync(candidate)) out.push(candidate);
    }
    if (stop === current) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/**
 * opencode's worktree for a directory: the git root, or `/` for a non-git
 * project (`project/project.ts:217`). Only used when the host did not say.
 */
export function findWorktree(directory: string): string {
  let current = directory;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return "/";
    current = parent;
  }
}

/**
 * Every config source opencode 1.18.32 merges, in its order
 * (`config/config.ts:412-565`). Each entry is a file path or an inline text.
 * Not mirrored: well-known remote configs and the active org's account config
 * (both need network + auth), and the macOS MDM plist (needs `plutil`); the
 * host bridge covers those when present.
 */
function configSources(
  directory: string,
  worktree: string,
  env: NodeJS.ProcessEnv,
  paths: OpencodePaths,
): Array<{ path: string } | { inline: string; source: string }> {
  const out: Array<{ path: string } | { inline: string; source: string }> = [];
  const disableProject = truthy(env.OPENCODE_DISABLE_PROJECT_CONFIG);
  // :272-274 — global config dir.
  for (const file of ["config.json", "opencode.json", "opencode.jsonc"]) out.push({ path: join(paths.config, file) });
  // :415-418 — OPENCODE_CONFIG after global, before project.
  if (env.OPENCODE_CONFIG) out.push({ path: env.OPENCODE_CONFIG });
  // :420-424 + `config/paths.ts:10-21` — project files, farthest first.
  if (!disableProject) {
    for (const path of up(["opencode.jsonc", "opencode.json"], directory, worktree).reverse()) out.push({ path });
  }
  // :430-448 + `config/paths.ts:23-41` — `.opencode` dirs (nearest first),
  // `~/.opencode`, then OPENCODE_CONFIG_DIR; json before jsonc in each.
  const configDir = env.OPENCODE_CONFIG_DIR;
  const directories = [
    paths.config,
    ...(!disableProject ? up([".opencode"], directory, worktree) : []),
    ...up([".opencode"], paths.home, paths.home),
    ...(configDir ? [configDir] : []),
  ].filter((dir, i, all) => all.indexOf(dir) === i);
  for (const dir of directories) {
    if (!dir.endsWith(".opencode") && dir !== configDir) continue;
    for (const file of ["opencode.json", "opencode.jsonc"]) out.push({ path: join(dir, file) });
  }
  // :482-490 — OPENCODE_CONFIG_CONTENT.
  if (env.OPENCODE_CONFIG_CONTENT) out.push({ inline: env.OPENCODE_CONFIG_CONTENT, source: "OPENCODE_CONFIG_CONTENT" });
  // :530-536 — managed config dir.
  const managed = managedConfigDir(env);
  for (const file of ["opencode.json", "opencode.jsonc"]) out.push({ path: join(managed, file) });
  return out;
}

/** Built-in per-agent overrides (`agent/agent.ts:140-265`), between defaults and the user block. */
function builtinAgentPermission(agent: string, paths: OpencodePaths, readonlyExternal: Json): Json | undefined {
  switch (agent) {
    case "build":
      return { question: "allow", plan_enter: "allow" };
    case "plan":
      return {
        question: "allow",
        plan_exit: "allow",
        task: { general: "deny" },
        external_directory: { [join(paths.data, "plans", "*")]: "allow" },
        edit: { "*": "deny", [join(".opencode", "plans", "*.md")]: "allow" },
      };
    case "general":
      return { todowrite: "deny" };
    case "explore":
      return {
        "*": "deny",
        grep: "allow",
        glob: "allow",
        list: "allow",
        bash: "allow",
        webfetch: "allow",
        websearch: "allow",
        read: "allow",
        external_directory: readonlyExternal,
      };
    case "compaction":
    case "title":
    case "summary":
      return { "*": "deny" };
    default:
      return undefined;
  }
}

export interface OpencodeRulesetOptions {
  /** The session's agent (`ToolContext.agent`); defaults to `default_agent` or `build`. */
  agent?: string;
  /** The project worktree (`ToolContext.worktree`); derived from `.git` when absent. */
  worktree?: string;
}

/** Build the agent ruleset from an already-merged config (`agent/agent.ts:108-310`). */
export function buildOpencodeRuleset(config: Json, env: NodeJS.ProcessEnv = process.env, agent?: string): PolicyRule[] {
  const paths = opencodePaths(env);
  const home = homedir();
  // `agent/agent.ts:108-113` — skill and reference dirs are omitted (they need
  // the host's skill/reference services); a missing allow only makes this
  // stricter, never looser.
  const truncateGlob = join(paths.data, "tool-output", "*");
  const whitelisted = [truncateGlob, join(paths.tmp, "*")];
  const readonlyExternal: Json = { "*": "ask", ...Object.fromEntries(whitelisted.map((dir) => [dir, "allow"])) };
  const defaults = rulesFromPermission({
    "*": "allow",
    doom_loop: "ask",
    external_directory: { "*": "ask", ...Object.fromEntries(whitelisted.map((dir) => [dir, "allow"])) },
    question: "deny",
    plan_enter: "deny",
    plan_exit: "deny",
    read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
  }, home);

  let permission = isPlainObject(config.permission) ? config.permission : {};
  // `config/config.ts:559-565` then `:567-578` — env permission, then legacy `tools`.
  if (isPlainObject(config.__opencodePermissionEnv)) permission = mergeDeep(permission, config.__opencodePermissionEnv);
  if (isPlainObject(config.tools)) {
    const perms: Json = {};
    for (const [tool, enabled] of Object.entries(config.tools)) {
      const action = enabled ? "allow" : "deny";
      if (tool === "write" || tool === "edit" || tool === "patch") perms.edit = action;
      else perms[tool] = action;
    }
    permission = mergeDeep(perms, permission);
  }
  const user = rulesFromPermission(permission, home);

  // `config/config.ts:550-557` — `mode.<name>` entries become agents.
  let agents: Json = isPlainObject(config.agent) ? config.agent : {};
  if (isPlainObject(config.mode)) {
    for (const [name, mode] of Object.entries(config.mode)) {
      if (isPlainObject(mode)) agents = mergeDeep(agents, { [name]: { ...mode, mode: "primary" } });
    }
  }
  const name = agent ?? (typeof config.default_agent === "string" ? config.default_agent : "build");
  const builtin = builtinAgentPermission(name, paths, readonlyExternal);
  let ruleset = [...defaults, ...(builtin ? rulesFromPermission(builtin, home) : []), ...user];
  const configured = agents[name];
  if (isPlainObject(configured) && isPlainObject(configured.permission)) {
    ruleset = [...ruleset, ...rulesFromPermission(configured.permission, home)];
  }
  // `agent/agent.ts:296-310` — the truncation dir stays readable unless explicitly denied.
  const explicit = ruleset.some((r) => r.permission === "external_directory" && r.action === "deny" && r.pattern === truncateGlob);
  if (!explicit) ruleset.push({ permission: "external_directory", pattern: truncateGlob, action: "allow" });
  return ruleset;
}

/**
 * Read the flattened ruleset opencode would evaluate for this project and
 * agent: every config layer mergeDeep'd in opencode's order, then the agent
 * ruleset built over it. Returns `{ error }` when any existing source fails to
 * parse — the checker then stops everything.
 */
export function readOpencodeRuleset(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: OpencodeRulesetOptions = {},
): OpencodeRuleset {
  const paths = opencodePaths(env);
  const worktree = options.worktree ?? findWorktree(projectDir);
  let merged: Json = {};
  for (const source of configSources(projectDir, worktree, env, paths)) {
    const where = "path" in source ? source.path : source.source;
    let text: string;
    if ("path" in source) {
      try {
        text = readFileSync(source.path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") continue;
        return { error: `${where} could not be read` };
      }
    } else text = source.inline;
    try {
      merged = mergeDeep(merged, parseOpencodeConfig(text, where));
    } catch {
      return { error: `${where} is not valid opencode JSON/JSONC` };
    }
  }
  if (env.OPENCODE_PERMISSION) {
    // opencode logs and SKIPS invalid OPENCODE_PERMISSION (`config/config.ts:559-565`);
    // predexec fails closed instead — a policy we cannot read is never "allow".
    try {
      const permission = normalizePermission(JSON.parse(env.OPENCODE_PERMISSION), "OPENCODE_PERMISSION");
      merged = { ...merged, __opencodePermissionEnv: permission };
    } catch {
      return { error: "OPENCODE_PERMISSION is not valid opencode permission JSON" };
    }
  }
  return buildOpencodeRuleset(merged, env, options.agent);
}

// ---------------------------------------------------------------------------
// Operation → opencode permission requests
// ---------------------------------------------------------------------------

/** One `ctx.ask` opencode's own tool would make for an equivalent call. */
export interface OpencodeAskRequest {
  permission: string;
  /** Exactly what opencode's own tool would send; the bridge asks with these. */
  patterns: string[];
  /**
   * Extra spellings the static check also evaluates, where only a DENY counts.
   * Never sent to the host, so they cannot add prompts.
   */
  denyOnlyPatterns?: string[];
}

/** `project/instance-context.ts:18-24` containsPath, over core `fs-util.ts:270-273` (lexical). */
function containsPath(filepath: string, directory: string, worktree: string): boolean {
  const contains = (parent: string, child: string): boolean => {
    const rel = relative(parent, child);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  };
  if (contains(directory, filepath)) return true;
  if (worktree === "/") return false;
  return contains(worktree, filepath);
}

const toPattern = (dir: string): string => join(dir, "*").replaceAll("\\", "/");

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** `tool/external-directory.ts:15-45`: one ask for the target's directory when outside the project. */
function externalDirectoryAsk(
  target: string,
  kind: "file" | "directory",
  directory: string,
  worktree: string,
): OpencodeAskRequest | null {
  if (containsPath(target, directory, worktree)) return null;
  const dir = kind === "directory" ? target : dirname(target);
  return { permission: "external_directory", patterns: [toPattern(dir)] };
}

/** `tool/shell.ts:28-50` — commands whose path arguments opencode checks. */
const SHELL_FILE_COMMANDS = new Set(["cd", "chdir", "popd", "pushd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"]);
const SHELL_CWD_COMMANDS = new Set(["cd", "chdir", "popd", "pushd"]);
const REDIRECT_WORD = /^\d*(?:[<>]|>>|&>|<<<?|<>|>\||>&|<&)\d*-?$/;

/**
 * The asks opencode's shell tool makes for one command string
 * (`tool/shell.ts:263-291, 373-413`): external_directory for path arguments of
 * file commands that leave the project, then bash for each command clause.
 * `null` means the command could not be fully inspected.
 */
function shellAsks(
  command: string,
  cwd: string,
  directory: string,
  worktree: string,
  inspectCommand: CommandPolicyInspector,
): OpencodeAskRequest[] | null {
  const inspected = inspectCommand(command);
  if (!inspected.complete) return null;
  const dirs: string[] = [];
  const patterns: string[] = [];
  // `tool/shell.ts:626` — a working directory outside the project is itself external.
  if (!containsPath(cwd, directory, worktree)) dirs.push(cwd);
  for (const inspectedCommand of inspected.commands) {
    for (const segment of splitCommandSegments(inspectedCommand)) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      const words = lexShellWords(trimmed).words;
      const head = words[0]?.value;
      if (head && SHELL_FILE_COMMANDS.has(head)) {
        // `tool/shell.ts:196-208` pathArgs + `:361-368` argPath: skip flags,
        // `chmod +x`, and anything the shell expands dynamically.
        for (const word of words.slice(1)) {
          const text = word.value;
          if (!text || text.startsWith("-") || REDIRECT_WORD.test(text)) continue;
          if (head === "chmod" && text.startsWith("+")) continue;
          if (word.dynamic) continue;
          const homed = text === "~" ? homedir() : text.startsWith("~/") ? join(homedir(), text.slice(2)) : text;
          const glob = /[?*[]/.exec(homed);
          if (glob?.index === 0) continue;
          const literal = glob ? homed.slice(0, glob.index) : homed;
          const resolved = resolve(cwd, literal);
          if (containsPath(resolved, directory, worktree)) continue;
          dirs.push(isDirectory(resolved) ? resolved : dirname(resolved));
        }
      }
      if (head && !SHELL_CWD_COMMANDS.has(head)) patterns.push(trimmed);
    }
  }
  const asks: OpencodeAskRequest[] = [];
  const uniq = (list: string[]) => list.filter((v, i) => list.indexOf(v) === i);
  if (dirs.length > 0) asks.push({ permission: "external_directory", patterns: uniq(dirs.map(toPattern)) });
  if (patterns.length > 0) asks.push({ permission: "bash", patterns: uniq(patterns) });
  return asks;
}

/**
 * A `read`/`list` request for a file path. opencode itself asks with the path
 * relative to the worktree (`tool/read.ts:255-260`); predexec also checks the
 * path relative to the session directory and as an absolute path for a DENY.
 * That keeps `~/secret/*` deny rules meaningful for paths outside the project
 * and directory-relative deny rules meaningful in non-git projects (worktree
 * `/`) — strictly tighter than the host, and never an extra prompt.
 */
function pathRequest(permission: string, abs: string, directory: string, worktree: string): OpencodeAskRequest {
  const host = relative(worktree, abs).replaceAll("\\", "/");
  const extra = [relative(directory, abs) || ".", abs].map((p) => p.replaceAll("\\", "/"));
  return { permission, patterns: [host], denyOnlyPatterns: extra.filter((v, i) => v !== host && extra.indexOf(v) === i) };
}

/**
 * The permission requests opencode would make for one predexec operation, in
 * opencode's own order. `null` for a shell command that could not be fully
 * inspected. Operations outside opencode's permission surface return [].
 */
export function opencodeAsksFor(
  operation: Operation,
  context: { cwd: string; directory: string; worktree: string },
  inspectCommand: CommandPolicyInspector = inspectCommandSubstitutionTree,
): OpencodeAskRequest[] | null {
  const { cwd, directory, worktree } = context;
  if (typeof operation === "string") return shellAsks(operation, cwd, directory, worktree, inspectCommand);
  if (operation.tool === "bash") {
    return typeof operation.command === "string" ? shellAsks(operation.command, cwd, directory, worktree, inspectCommand) : [];
  }
  const target = resolve(directory, typeof operation.path === "string" ? operation.path : ".");
  const pattern = typeof operation.pattern === "string" ? operation.pattern : "*";
  const external = (kind: "file" | "directory") => externalDirectoryAsk(target, kind, directory, worktree);
  const asks: Array<OpencodeAskRequest | null> = [];
  switch (operation.tool) {
    case "read":
      // `tool/read.ts:250-260`.
      asks.push(external(isDirectory(target) ? "directory" : "file"));
      asks.push(pathRequest("read", target, directory, worktree));
      break;
    case "ls":
      // No `list` tool ships in 1.18.32; a directory read is how opencode lists.
      // The documented `list` key is checked too, so a rule under either applies.
      asks.push(external("directory"));
      asks.push(pathRequest("read", target, directory, worktree));
      asks.push(pathRequest("list", target, directory, worktree));
      break;
    case "grep":
      // `tool/grep.ts:39-58`: the regex is the pattern, then the path's directory.
      asks.push({ permission: "grep", patterns: [pattern] });
      asks.push(external(isDirectory(target) ? "directory" : "file"));
      break;
    case "find":
      // `tool/glob.ts:30-47`: the glob is the pattern, then the search directory.
      asks.push({ permission: "glob", patterns: [pattern] });
      asks.push(pathRequest("list", target, directory, worktree));
      asks.push(external("directory"));
      break;
    default:
      return [];
  }
  return asks.filter((a): a is OpencodeAskRequest => a !== null);
}

// ---------------------------------------------------------------------------
// Checkers
// ---------------------------------------------------------------------------

export interface PolicyCheckerOptions {
  /** Session directory; the engine's `sessionRoot` wins when it passes one. */
  directory?: string;
  /** Project worktree; derived from `.git` when absent. */
  worktree?: string;
  inspectCommand?: CommandPolicyInspector;
}

/** A static verdict for one operation: the strictest over every request and pattern. */
export interface StaticVerdict {
  action: PolicyAction;
  /** The rule behind a deny/ask, formatted for the transcript. */
  rule?: string;
}

const INCOMPLETE = "incomplete shell syntax (policy inspection could not read the whole command)";

function describeRule(request: OpencodeAskRequest, rule: PolicyRule): string {
  return request.permission === "bash" ? rule.pattern : `${request.permission}:${rule.pattern}`;
}

function staticVerdict(requests: OpencodeAskRequest[], ruleset: PolicyRule[]): StaticVerdict {
  let ask: string | undefined;
  for (const request of requests) {
    for (const pattern of request.patterns) {
      const rule = evaluatePermission(request.permission, pattern, ruleset);
      // `permission/index.ts:72-82` — a deny anywhere rejects the whole request.
      if (rule.action === "deny") return { action: "deny", rule: describeRule(request, rule) };
      if (rule.action === "ask" && ask === undefined) ask = describeRule(request, rule);
    }
    for (const pattern of request.denyOnlyPatterns ?? []) {
      const rule = evaluatePermission(request.permission, pattern, ruleset);
      if (rule.action === "deny") return { action: "deny", rule: describeRule(request, rule) };
    }
  }
  return ask === undefined ? { action: "allow" } : { action: "ask", rule: ask };
}

function unreadableReason(ruleset: { error: string }): string {
  // Name the source and the remedy: without that this reads as a predexec bug
  // rather than a syntax error in the user's own config.
  return `cannot read your opencode permission rules (${ruleset.error}) — ` +
    `predexec stops rather than run commands your policy might forbid; fix it to continue`;
}

function resolveContext(options: PolicyCheckerOptions, context?: PolicyCheckContext) {
  const directory = context?.sessionRoot ?? options.directory ?? process.cwd();
  return {
    directory,
    cwd: context?.cwd ?? directory,
    worktree: options.worktree ?? findWorktree(directory),
  };
}

/** The strictest static verdict for an operation (exposed for tests and the bridge). */
export function evaluateOperation(
  operation: Operation,
  ruleset: OpencodeRuleset,
  options: PolicyCheckerOptions = {},
  context?: PolicyCheckContext,
): StaticVerdict {
  if (!Array.isArray(ruleset)) return { action: "deny", rule: unreadableReason(ruleset) };
  try {
    const requests = opencodeAsksFor(operation, resolveContext(options, context), options.inspectCommand);
    if (requests === null) return { action: "deny", rule: INCOMPLETE };
    return staticVerdict(requests, ruleset);
  } catch {
    return { action: "deny", rule: "incomplete shell syntax (policy inspection failed)" };
  }
}

/**
 * The static operation-aware policy callback (used when the host offers no
 * `context.ask`): deny AND ask both stop, because it cannot prompt. Returns the
 * rule that stopped the operation, or null to run it.
 */
export function createPolicyChecker(
  ruleset: OpencodeRuleset,
  options: PolicyCheckerOptions = {},
): (operation: Operation, context?: PolicyCheckContext) => PolicyVerdict {
  return (operation, context) => {
    const verdict = evaluateOperation(operation, ruleset, options, context);
    return verdict.action === "allow" ? null : verdict.rule ?? "*";
  };
}

/** opencode's plugin `ToolContext.ask` (`@opencode-ai/plugin` `src/tool.ts:19-27`). */
export type OpencodeAsk = (input: {
  permission: string;
  patterns: string[];
  always: string[];
  metadata: { [key: string]: unknown };
}) => Promise<void>;

/**
 * Bridge predexec's policy seam to opencode's real permission service.
 *
 * The static reader still runs first: a static `deny` stops at once without
 * prompting. Otherwise each request goes to `context.ask`, which evaluates the
 * host's live ruleset (`permission/index.ts:67-107`): an allow resolves
 * silently, an ask prompts the user, a deny or a rejection rejects. Any
 * resolution (once or always) runs; any rejection is a policyStop carrying
 * opencode's reason as a `HostPolicyDenial`. `always` is sent empty so
 * predexec never widens the host's standing approvals.
 *
 * One bridge serves one walk, and it keeps host prompts to what opencode's
 * own tools would ask:
 * - Each request is sent once with its not-yet-approved patterns (one prompt
 *   per request); an approved permission+pattern is never asked again.
 * - A variant spelling (`context.variant`: an inner `sh -c` clause or decoded
 *   argv form of an operation whose primary spelling passed) is judged
 *   statically. A deny stops; an ask reaches the host only when it is stricter
 *   than the primary's static verdict; otherwise the primary's approval covers it.
 * - After ANY stop (static or host) the rest of the walk is static-only: the
 *   node will not run, so prompting for its later operations is pointless.
 * - An aborted signal stops asking.
 */
export function createOpencodeAskBridge(
  ask: OpencodeAsk,
  ruleset: OpencodeRuleset,
  options: PolicyCheckerOptions & { signal?: AbortSignal } = {},
): (operation: Operation, context?: PolicyCheckContext) => Promise<PolicyVerdict> {
  const approved = new Set<string>();
  const primaryAction = new Map<number, PolicyAction>();
  const strictness: Record<PolicyAction, number> = { allow: 0, ask: 1, deny: 2 };
  let stopped = false;
  const stop = (verdict: string | HostPolicyDenial): string | HostPolicyDenial => {
    stopped = true;
    return verdict;
  };

  return async (operation, context) => {
    const pre = evaluateOperation(operation, ruleset, options, context);
    if (stopped) return pre.action === "allow" ? null : pre.rule ?? "*";
    if (pre.action === "deny") return stop(pre.rule ?? "*");
    const index = context?.operationIndex;
    if (context?.variant) {
      if (pre.action === "allow") return null;
      const primary = index === undefined ? undefined : primaryAction.get(index);
      if (primary !== undefined && strictness[pre.action] <= strictness[primary]) return null;
    } else if (index !== undefined) {
      primaryAction.set(index, pre.action);
    }
    const requests = opencodeAsksFor(operation, resolveContext(options, context), options.inspectCommand);
    if (requests === null) return stop(INCOMPLETE);
    const signal = context?.signal ?? options.signal;
    for (const request of requests) {
      const key = (pattern: string) => `${request.permission}\u0000${pattern}`;
      const pending = request.patterns.filter((pattern) => !approved.has(key(pattern)));
      if (pending.length === 0) continue;
      if (signal?.aborted) return stop("aborted before asking opencode for permission");
      try {
        await ask({
          permission: request.permission,
          patterns: pending,
          always: [],
          metadata: { source: "predexec", operation: typeof operation === "string" ? operation : { ...operation } },
        });
      } catch (err) {
        const reason = err instanceof Error && err.message ? err.message : String(err);
        return stop({ hostDenied: `opencode denied permission: ${reason}` });
      }
      for (const pattern of pending) approved.add(key(pattern));
    }
    return null;
  };
}
