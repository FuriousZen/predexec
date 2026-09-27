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

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  commandsWithUnresolvableOperands,
  describeUnresolvableOperand,
  inspectCommandSubstitutionTree,
  lexShellWords,
  operandHeadMayReadPaths,
  ruleHeadCouldMatch,
  splitCommandSegments,
  tokenizeShellWords,
} from "./core/index.ts";
import type { HostPolicyDenial, Operation, PolicyCheckContext, PolicyVerdict } from "./core/types.ts";
import { MAX_FRONTMATTER_FILE_BYTES, parseFrontmatter } from "./yaml-frontmatter.ts";

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
  /**
   * The opencode major the ruleset is for; default `1`. `2` builds the ruleset
   * with opencode v2's own model instead (`readOpencodeV2Ruleset`).
   */
  hostMajor?: 1 | 2;
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
  if (options.hostMajor === 2) return readOpencodeV2Ruleset(projectDir, env, options.agent);
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
// opencode v2 ruleset model (tag v2.0.16, commit 3a103fe; citations below are
// into that tree's `packages/`). v2 does NOT mergeDeep config layers: every
// document is normalized to its own ordered rule list and the lists are
// concatenated in load order; evaluation is still last-match-wins.
// ---------------------------------------------------------------------------

/** OpencodePaths plus v2's global config dir (`OPENCODE_CONFIG_DIR` replaces it — util `global.ts:79`). */
type V2Paths = OpencodePaths & { v2Config: string };

/** A config document, or `agentDir`: that directory's agent/mode markdown files (core `config.ts:185-192` Directory entries). */
type V2Source = { path: string } | { inline: string; source: string } | { agentDir: string };

const realOrResolved = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Every config document v2 loads, lowest priority first (core `config.ts:196-237`
 * `load`: global dir files, `OPENCODE_CONFIG`, direct project files,
 * `.opencode` dirs, `OPENCODE_CONFIG_CONTENT`), with discovery from
 * `config/discovery.ts:23-84`: the walk runs from the session directory to the
 * FILESYSTEM ROOT (`fs.up` with no stop, util `fs-util.ts:162-178`), each
 * directory contributing `.claude`/`.agents`/`.opencode`/`opencode.jsonc`/
 * `opencode.json` when they exist; entries resolving to a global root or global
 * file are dropped; direct files and `.opencode` dirs are then ordered farthest
 * first. Within a directory `opencode.json` loads before `opencode.jsonc`
 * (`discovery.ts:11`, `config.ts:185-192`). Env names from cli
 * `server-process.ts:108-115` and util `global.ts:79`.
 * Not mirrored: well-known (Console/integration) configs, which need network
 * and credentials.
 */
function v2ConfigSources(directory: string, env: NodeJS.ProcessEnv, paths: V2Paths): V2Source[] {
  const names = ["opencode.json", "opencode.jsonc"];
  const globalDir = paths.v2Config;
  const globalRoots = [globalDir, join(paths.home, ".claude"), join(paths.home, ".agents")].map(realOrResolved);
  const globalFiles = names.map((n) => realOrResolved(join(globalDir, n)));
  const disableRaw = env.OPENCODE_CONFIG_PROJECT_DISABLE ?? env.OPENCODE_DISABLE_PROJECT_CONFIG;
  const projectEnabled = !truthy(disableRaw);
  const found: string[] = [];
  if (projectEnabled && realOrResolved(directory) !== globalRoots[0]) {
    let current = resolve(directory);
    for (;;) {
      for (const name of [".claude", ".agents", ".opencode", ...[...names].reverse()]) {
        const candidate = join(current, name);
        if (existsSync(candidate)) found.push(candidate);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const visible = found.filter((item) => {
    const resolved = realOrResolved(item);
    return !globalRoots.includes(resolved) && !globalFiles.includes(resolved);
  });
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const out: V2Source[] = [...names.map((n) => ({ path: join(globalDir, n) })), { agentDir: globalDir }];
  if (env.OPENCODE_CONFIG) out.push({ path: resolve(env.OPENCODE_CONFIG) });
  for (const file of visible.filter((i) => ![".claude", ".agents", ".opencode"].includes(basename(i))).reverse()) {
    out.push({ path: file });
  }
  for (const dir of visible.filter((i) => basename(i) === ".opencode").reverse()) {
    if (!isDir(dir)) continue;
    for (const n of names) out.push({ path: join(dir, n) });
    out.push({ agentDir: dir });
  }
  if (env.OPENCODE_CONFIG_CONTENT !== undefined) out.push({ inline: env.OPENCODE_CONFIG_CONTENT, source: "OPENCODE_CONFIG_CONTENT" });
  return out;
}

/** core `v1/config/migrate.ts:117-122`. */
function v2NormalizeAction(action: string): string {
  if (action === "write" || action === "patch") return "edit";
  if (action === "task") return "subagent";
  if (action === "bash") return "shell";
  return action;
}

/** core `config/plugin/agent.ts:141-162` — only path actions get `~`/`$HOME` expanded. */
function v2ExpandHome(rule: PolicyRule, home: string): PolicyRule {
  if (!["external_directory", "read", "edit"].includes(rule.permission)) return rule;
  const r = rule.pattern;
  if (r === "~" || r === "$HOME") return { ...rule, pattern: home };
  const rest = r.startsWith("~/") ? r.slice(2) : r.startsWith("$HOME/") || r.startsWith("$HOME\\") ? r.slice(6) : undefined;
  return rest === undefined ? rule : { ...rule, pattern: join(home, rest) };
}

/** A v1-form `permission` value as v2 migrates it (core `config/normalize.ts:496-522`). */
function v2MigratePermission(value: unknown, where: string): PolicyRule[] {
  if (value === undefined) return [];
  if (isAction(value)) return [{ permission: "*", pattern: "*", action: value }];
  if (!isPlainObject(value)) throw new Error(`${where}: permission must be an action or an object`);
  const out: PolicyRule[] = [];
  for (const [key, raw] of Object.entries(value)) {
    const permission = v2NormalizeAction(key);
    if (isAction(raw)) {
      out.push({ permission, pattern: "*", action: raw });
      continue;
    }
    if (!isPlainObject(raw)) throw new Error(`${where}: permission.${key} is not a valid rule`);
    for (const [pattern, action] of Object.entries(raw)) {
      if (!isAction(action)) throw new Error(`${where}: permission.${key}["${pattern}"] is not allow/ask/deny`);
      out.push({ permission, pattern, action });
    }
  }
  return out;
}

/** Native `permissions: [{action, resource, effect}]` (schema `permission.ts:55-66`); NOT action-normalized. */
function v2NativePermissions(value: unknown, where: string): PolicyRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${where}: permissions must be an array`);
  return value.map((rule, i) => {
    if (!isPlainObject(rule) || typeof rule.action !== "string" || typeof rule.resource !== "string" || !isAction(rule.effect)) {
      throw new Error(`${where}: permissions[${i}] is not a valid {action, resource, effect} rule`);
    }
    return { permission: rule.action, pattern: rule.resource, action: rule.effect };
  });
}

/** Legacy `tools: {name: boolean}` (core `config/normalize.ts:484-494`). */
function v2MigrateTools(value: unknown, where: string): PolicyRule[] {
  if (value === undefined) return [];
  if (!isPlainObject(value)) throw new Error(`${where}: tools must be an object`);
  return Object.entries(value).map(([key, enabled]) => {
    if (typeof enabled !== "boolean") throw new Error(`${where}: tools.${key} must be a boolean`);
    return { permission: v2NormalizeAction(key), pattern: "*", action: enabled ? "allow" : "deny" } as PolicyRule;
  });
}

/** One agent definition as a document contributes it (core `config/plugin/agent.ts:93-124`). */
interface V2Agent {
  rules: PolicyRule[];
  mode?: string;
  hidden?: boolean;
}
/** `null` = the document disables the agent; `{ error }` = predexec could not read it (fail closed for that agent). */
type V2AgentEntry = V2Agent | null | { error: string };

interface V2Document {
  /** `[...tools, ...permission, ...permissions]` — core `config/normalize.ts:179-183`. */
  rules: PolicyRule[];
  agents: Map<string, V2AgentEntry>;
  defaultAgent?: string;
}

const V2_AGENT_MODES = new Set(["subagent", "primary", "all"]);
const V1_THEME_COLORS = new Set(["primary", "secondary", "accent", "success", "warning", "error", "info"]);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Full-schema field checks (R44). v2 DROPS an agent whose decode fails
 * (core `config/plugin/agent.ts:193-209` for files; `config/normalize.ts:131-166`
 * decodeMap for config entries), so applying such an agent's rules could allow
 * what the surviving rules deny. predexec instead throws, which makes that
 * agent deny-all (files) or the whole config unreadable (config documents).
 * Every declared field is checked; `optionalKey` fields reject `null`
 * (schema `schema.ts:12-16`).
 */
type FieldCheck = (v: unknown) => boolean;
const isStr: FieldCheck = (v) => typeof v === "string";
const isBool: FieldCheck = (v) => typeof v === "boolean";
const isFinite_: FieldCheck = (v) => typeof v === "number" && Number.isFinite(v);
const isPosInt: FieldCheck = (v) => typeof v === "number" && Number.isInteger(v) && v > 0; // schema `schema.ts:3`
const isMode: FieldCheck = (v) => typeof v === "string" && V2_AGENT_MODES.has(v);
const isRecordOf = (check: FieldCheck): FieldCheck => (v) => isPlainObject(v) && Object.values(v).every(check);
const isJson: FieldCheck = (v) =>
  v === null || ["string", "boolean"].includes(typeof v) || isFinite_(v) || (Array.isArray(v) && v.every(isJson)) || isRecordOf(isJson)(v);

/** ConfigPermissionV1.Info (core `v1/config/permission.ts:5-48`): an action, or keys → action | {pattern: action}; `question`/`websearch`/`doom_loop` take an action only. */
const isV1Permission: FieldCheck = (v) =>
  isAction(v) ||
  (isPlainObject(v) &&
    Object.entries(v).every(([key, rule]) =>
      ["question", "websearch", "doom_loop"].includes(key) ? isAction(rule) : isAction(rule) || isRecordOf(isAction)(rule),
    ));

/** Native model selection (schema `config/model.ts:8-28`): `provider/model[#variant]` or `{providerID, model, variant?}`. */
const isModelSelection: FieldCheck = (v) => {
  if (typeof v === "string") return /^[^/#]+\/[^#]+(?:#[^#]+)?$/.test(v);
  if (!isPlainObject(v)) return false;
  return (
    typeof v.providerID === "string" && /^[^/#]+$/.test(v.providerID) &&
    typeof v.model === "string" && /^[^#]+$/.test(v.model) &&
    (v.variant === undefined || (typeof v.variant === "string" && /^[^#]+$/.test(v.variant)))
  );
};

/** ConfigProvider.Request (schema `config/provider.ts:30-45`). */
const isRequest: FieldCheck = (v) =>
  isPlainObject(v) &&
  (v.headers === undefined || isRecordOf(isStr)(v.headers)) &&
  (v.body === undefined || isRecordOf(isJson)(v.body));

const isNativeRuleset: FieldCheck = (v) =>
  Array.isArray(v) &&
  v.every((r) => isPlainObject(r) && typeof r.action === "string" && typeof r.resource === "string" && isAction(r.effect));

/** Legacy agent schema, core `v1/config/agent.ts:12-39`; unknown keys are allowed (StructWithRest of Any). */
const V1_AGENT_FIELDS: Record<string, FieldCheck> = {
  model: isStr,
  variant: isStr,
  temperature: isFinite_,
  top_p: isFinite_,
  prompt: isStr,
  tools: isRecordOf(isBool),
  disable: isBool,
  description: isStr,
  mode: isMode,
  hidden: isBool,
  options: isPlainObject,
  color: (v) => typeof v === "string" && (HEX_COLOR.test(v) || V1_THEME_COLORS.has(v)),
  steps: isPosInt,
  maxSteps: isPosInt,
  permission: isV1Permission,
};

/** Native agent schema, schema `config/agent.ts:11-22`; excess keys are ignored by the decode. */
const NATIVE_AGENT_FIELDS: Record<string, FieldCheck> = {
  model: isModelSelection,
  request: isRequest,
  system: isStr,
  description: isStr,
  mode: isMode,
  hidden: isBool,
  color: (v) => typeof v === "string" && HEX_COLOR.test(v),
  steps: isPosInt,
  disabled: isBool,
  permissions: isNativeRuleset,
};

function v2CheckFields(value: Json, fields: Record<string, FieldCheck>, where: string): void {
  for (const [key, check] of Object.entries(fields)) {
    if (Object.prototype.hasOwnProperty.call(value, key) && !check(value[key])) {
      throw new Error(`${where}: \`${key}\` does not match opencode v2's agent schema`);
    }
  }
}

const v2AgentShape = (value: Json, disabled: boolean, rules: PolicyRule[]): V2Agent | null =>
  disabled
    ? null
    : {
        rules,
        ...(typeof value.mode === "string" ? { mode: value.mode } : {}),
        ...(typeof value.hidden === "boolean" ? { hidden: value.hidden } : {}),
      };

/**
 * A legacy (v1-shaped) agent: its `tools` map becomes a permission object
 * (`write`/`edit`/`patch` → `edit`), then `permission` is `Object.assign`ed
 * over it (core `v1/config/agent.ts:44-61`), then migrated
 * (`v1/config/migrate.ts:140-161`, `normalizeAction`).
 */
function v2LegacyAgent(value: Json, where: string): V2Agent | null {
  v2CheckFields(value, V1_AGENT_FIELDS, where);
  const permission: Json = {};
  for (const [tool, enabled] of Object.entries((value.tools as Record<string, boolean> | undefined) ?? {})) {
    permission[tool === "write" || tool === "edit" || tool === "patch" ? "edit" : tool] = enabled ? "allow" : "deny";
  }
  if (value.permission !== undefined) {
    Object.assign(permission, isAction(value.permission) ? { "*": value.permission } : value.permission);
  }
  return v2AgentShape(value, value.disable === true, v2MigratePermission(permission, where));
}

/** A native `agents.<name>` value (schema `config/agent.ts:11-22`). */
function v2NativeAgent(value: Json, where: string): V2Agent | null {
  v2CheckFields(value, NATIVE_AGENT_FIELDS, where);
  return v2AgentShape(value, value.disabled === true, v2NativePermissions(value.permissions, where));
}

/**
 * One document's agent section: legacy `agent` then `mode` (mode wins per
 * name, and forces `mode: primary`), then native `agents` replacing a name
 * wholesale (core `config/normalize.ts:131-166` + `mergeMaps` `:731-743`).
 */
function v2DocumentAgents(config: Json, where: string): Map<string, V2AgentEntry> {
  const merged = new Map<string, { legacy: boolean; value: Json }>();
  for (const section of ["agent", "mode"] as const) {
    const entries = config[section];
    if (entries === undefined) continue;
    if (!isPlainObject(entries)) throw new Error(`${where}: ${section} must be an object`);
    for (const [name, value] of Object.entries(entries)) {
      if (!isPlainObject(value)) throw new Error(`${where}: ${section}.${name} must be an object`);
      merged.set(name, { legacy: true, value: section === "mode" ? { ...value, mode: "primary" } : value });
    }
  }
  if (config.agents !== undefined) {
    if (!isPlainObject(config.agents)) throw new Error(`${where}: agents must be an object`);
    for (const [name, value] of Object.entries(config.agents)) {
      if (!isPlainObject(value)) throw new Error(`${where}: agents.${name} must be an object`);
      merged.set(name, { legacy: false, value });
    }
  }
  const out = new Map<string, V2AgentEntry>();
  for (const [name, { legacy, value }] of merged) {
    out.set(name, legacy ? v2LegacyAgent(value, `${where} agent.${name}`) : v2NativeAgent(value, `${where} agents.${name}`));
  }
  return out;
}

function v2Document(config: Json, where: string): V2Document {
  return {
    rules: [
      ...v2MigrateTools(config.tools, where),
      ...v2MigratePermission(config.permission, where),
      ...v2NativePermissions(config.permissions, where),
    ],
    agents: v2DocumentAgents(config, where),
    ...(typeof config.default_agent === "string" ? { defaultAgent: config.default_agent } : {}),
  };
}

/** Frontmatter keys of a native agent file; any other key makes the file legacy (core `config/plugin/agent.ts:32,184`). */
const V2_NATIVE_AGENT_KEYS = new Set(["variant", "model", "request", "system", "description", "mode", "hidden", "color", "steps", "disabled", "permissions"]);

/**
 * Agent/mode markdown files under one config directory, in v2's order: one
 * sorted scan of `{agent,agents}/**\/*.md`, then one of `{mode,modes}/*.md`
 * (mode files are primary) — core `config/plugin/agent.ts:21-24,164-176`
 * (`fs.scan` with `dot: true, symlink: true`).
 */
function v2AgentFiles(directory: string): Array<{ file: string; primary: boolean }> {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const agentFiles: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string) => {
    const real = realOrResolved(dir);
    if (seen.has(real)) return;
    seen.add(real);
    for (const name of list(dir)) {
      const p = join(dir, name);
      if (name.endsWith(".md") && isFile(p)) agentFiles.push(p);
      else {
        try {
          if (statSync(p).isDirectory()) walk(p);
        } catch {
          /* dangling link */
        }
      }
    }
  };
  for (const sub of ["agent", "agents"]) walk(join(directory, sub));
  const modeFiles = ["mode", "modes"].flatMap((sub) =>
    list(join(directory, sub))
      .filter((name) => name.endsWith(".md"))
      .map((name) => join(directory, sub, name))
      .filter(isFile),
  );
  return [
    ...agentFiles.sort().map((file) => ({ file, primary: false })),
    ...modeFiles.sort().map((file) => ({ file, primary: true })),
  ];
}

/**
 * One agent markdown file as the document v2 makes of it (core
 * `config/plugin/agent.ts:177-211`): the name is the path under the config dir
 * minus the leading `agent(s)/`/`mode(s)/` and `.md`; frontmatter with any
 * non-native key is decoded as a legacy agent. v2 silently skips a file it
 * cannot decode; predexec fails closed for THAT agent instead.
 */
function v2MarkdownAgentDocument(directory: string, file: string, primary: boolean): V2Document | null {
  const name = relative(directory, file)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "");
  const agents = new Map<string, V2AgentEntry>();
  try {
    // Size cap before reading: the parse is synchronous on the policy path.
    if (statSync(file).size > MAX_FRONTMATTER_FILE_BYTES) throw new Error("agent file too large");
    const content = readFileSync(file, "utf8");
    // v2 skips an empty file outright (`content ? decode(...) : undefined`, agent.ts:44).
    if (content === "") return null;
    const { data } = parseFrontmatter(content);
    const legacy = Object.keys(data).some((key) => !V2_NATIVE_AGENT_KEYS.has(key));
    // Native files join a string model with a string variant before decode (agent.ts:190-196).
    const native =
      typeof data.model === "string" && !data.model.includes("#") && typeof data.variant === "string" && /^[^#]+$/.test(data.variant)
        ? { ...data, model: `${data.model}#${data.variant}` }
        : data;
    const agent = legacy ? v2LegacyAgent(data, file) : v2NativeAgent(native, file);
    agents.set(name, agent && primary ? { ...agent, mode: "primary" } : agent);
  } catch (err) {
    agents.set(name, { error: `${file} could not be read as an opencode agent (${err instanceof Error ? err.message : String(err)})` });
  }
  return { rules: [], agents };
}

/** Built-in agent pushes (core `plugin/agent.ts:85-156`, `plugin/plan.ts:32-42`), after `Info.default`. */
function v2BuiltinAgentRules(agent: string, paths: V2Paths): PolicyRule[] | undefined {
  const r = (permission: string, pattern: string, action: PolicyAction): PolicyRule => ({ permission, pattern, action });
  switch (agent) {
    case "build":
      return [r("question", "*", "allow")];
    case "general":
      return [r("question", "*", "deny"), r("subagent", "*", "deny")];
    case "explore":
      return [
        r("*", "*", "deny"),
        r("grep", "*", "allow"),
        r("glob", "*", "allow"),
        r("webfetch", "*", "allow"),
        r("websearch", "*", "allow"),
        r("read", "*", "allow"),
        r("read", "*.env", "ask"),
        r("read", "*.env.*", "ask"),
        r("read", "*.env.example", "allow"),
        r("subagent", "*", "deny"),
        r("external_directory", "*", "ask"),
        ...v2GlobalExternals(paths),
      ];
    case "compaction":
      return [];
    case "title":
    case "summary":
      return [r("*", "*", "deny")];
    case "plan": {
      const planDir = join(paths.home, ".opencode", "plan");
      return [
        r("question", "*", "allow"),
        r("edit", "*", "deny"),
        r("edit", join(planDir, "*"), "allow"),
        r("external_directory", join(planDir, "*"), "allow"),
      ];
    }
    default:
      return undefined;
  }
}

/** core `agent.ts:59-64` — external-directory allows every agent starts with. */
function v2GlobalExternals(paths: V2Paths): PolicyRule[] {
  return [
    join(paths.data, "shell", "*", "*"),
    join(paths.data, "tool-output", "*"),
    join(paths.tmp, "*"),
    join(paths.v2Config, "*"),
  ].map((pattern) => ({ permission: "external_directory", pattern, action: "allow" as const }));
}

/** `Agent.Info.default` (schema `agent.ts:39-54`) + the global externals. */
function v2AgentDefaults(paths: V2Paths): PolicyRule[] {
  return [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
    ...v2GlobalExternals(paths),
  ];
}

/**
 * Built-in agents in registration order with their mode/hidden (core
 * `plugin/agent.ts:85-156`; `plan` from `plugin/plan.ts:32-42`, assumed to
 * register after `opencode.agent`).
 */
const V2_BUILTIN_AGENTS: ReadonlyArray<[string, string, boolean]> = [
  ["build", "primary", false],
  ["general", "subagent", false],
  ["explore", "subagent", false],
  ["compaction", "primary", true],
  ["title", "primary", true],
  ["summary", "primary", true],
  ["plan", "primary", false],
];

type V2AgentState = { rules: PolicyRule[]; mode: string; hidden: boolean } | { error: string };

/**
 * The ruleset opencode v2 evaluates for `agent` (core `config/plugin/agent.ts:83-124`):
 * every agent that already exists (the built-ins) gets ALL documents'
 * top-level rules appended; then, document by document (JSON configs and agent
 * markdown files in load order), each agent entry creates the agent if needed
 * (defaults + all top-level rules), updates its mode/hidden and appends its own
 * rules, or removes it when disabled. An agent that does not exist at the end
 * evaluates as `[* * deny]` (core `permission.ts:19,162`). Without an explicit
 * agent the default is chosen like core `agent.ts:94-104`: `default_agent` if
 * selectable (not a subagent, not hidden), else `build` if selectable, else the
 * first selectable agent. An agent whose definition predexec could not read is
 * `{ error }` (fail closed for that agent only). `session.permissions`
 * (`permission.ts:162`) are runtime state and are not modeled.
 */
function buildOpencodeV2Ruleset(documents: V2Document[], paths: V2Paths, agent?: string): OpencodeRuleset {
  const top = documents.flatMap((d) => d.rules).map((rule) => v2ExpandHome(rule, paths.home));
  const agents = new Map<string, V2AgentState>();
  for (const [id, mode, hidden] of V2_BUILTIN_AGENTS) {
    agents.set(id, { rules: [...v2AgentDefaults(paths), ...(v2BuiltinAgentRules(id, paths) ?? []), ...top], mode, hidden });
  }
  for (const document of documents) {
    for (const [name, entry] of document.agents) {
      const current = agents.get(name);
      if (current && "error" in current) continue; // stays failed closed
      if (entry === null) {
        agents.delete(name);
        continue;
      }
      if ("error" in entry) {
        agents.set(name, entry);
        continue;
      }
      const state = current ?? { rules: [...v2AgentDefaults(paths), ...top], mode: "primary", hidden: false };
      if (!current) agents.set(name, state);
      if (entry.mode !== undefined) state.mode = entry.mode;
      if (entry.hidden !== undefined) state.hidden = entry.hidden;
      state.rules.push(...entry.rules.map((rule) => v2ExpandHome(rule, paths.home)));
    }
  }
  let name = agent;
  if (name === undefined) {
    const selectable = (id: string | undefined): boolean => {
      const a = id === undefined ? undefined : agents.get(id);
      return a !== undefined && ("error" in a || (a.mode !== "subagent" && !a.hidden));
    };
    const configured = documents.findLast((d) => d.defaultAgent !== undefined)?.defaultAgent;
    name = selectable(configured) ? configured : selectable("build") ? "build" : [...agents.keys()].find((id) => selectable(id));
  }
  const state = name === undefined ? undefined : agents.get(name);
  if (state === undefined) return [{ permission: "*", pattern: "*", action: "deny" }];
  return "error" in state ? { error: state.error } : state.rules;
}

/** v2 counterpart of `readOpencodeRuleset`; `{ error }` (stop everything) on any unparseable config document. */
function readOpencodeV2Ruleset(directory: string, env: NodeJS.ProcessEnv, agent?: string): OpencodeRuleset {
  const base = opencodePaths(env);
  // `??`, not `||`: an empty OPENCODE_CONFIG_DIR is a value to v2 (util `global.ts:79`).
  const paths: V2Paths = { ...base, v2Config: env.OPENCODE_CONFIG_DIR ?? base.config };
  const documents: V2Document[] = [];
  for (const source of v2ConfigSources(directory, env, paths)) {
    if ("agentDir" in source) {
      for (const { file, primary } of v2AgentFiles(source.agentDir)) {
        const document = v2MarkdownAgentDocument(source.agentDir, file, primary);
        if (document) documents.push(document);
      }
      continue;
    }
    const where = "path" in source ? source.path : source.source;
    let text: string;
    if ("path" in source) {
      try {
        text = readFileSync(source.path, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") continue;
        return { error: `${where} could not be read` };
      }
    } else text = source.inline;
    // v2 logs and SKIPS an unparseable document (core `config.ts:104-133`);
    // predexec fails closed instead — dropping it could drop a deny.
    try {
      documents.push(v2Document(parseV2Config(text, where), where));
    } catch (err) {
      return { error: `${where} is not a valid opencode v2 config (${err instanceof Error ? err.message : String(err)})` };
    }
  }
  return buildOpencodeV2Ruleset(documents, paths, agent);
}

/**
 * Drops commas that directly precede `}`/`]` outside strings — v2 parses with
 * jsonc-parser `allowTrailingComma: true` (core `config.ts:104-106`).
 */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

function parseV2Config(text: string, where: string): Json {
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  if (!isPlainObject(parsed)) throw new Error(`${where}: config must be a JSON object`);
  return parsed;
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
  /**
   * `2` evaluates requests the way opencode v2 names and scopes them: the
   * shell tool asks as `shell` (core `tool/plugin/shell.ts:22,133-141`) and
   * file reads use directory-relative resources (core `file-access.ts:100-111`)
   * — so every spelling predexec computes is checked for deny AND ask, never
   * only the v1 worktree-relative one. Default `1`.
   */
  hostMajor?: 1 | 2;
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

function staticVerdict(requests: OpencodeAskRequest[], ruleset: PolicyRule[], hostMajor: 1 | 2 = 1): StaticVerdict {
  let ask: string | undefined;
  if (hostMajor === 2) {
    requests = requests.map((r) => ({
      permission: r.permission === "bash" ? "shell" : r.permission,
      patterns: [...r.patterns, ...(r.denyOnlyPatterns ?? [])],
    }));
  }
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

/**
 * Deny/ask rules under `permission` that a later catch-all allow for the same
 * permission does not override (last match wins, so such a rule can never decide).
 */
function liveRestrictiveRules(ruleset: PolicyRule[], permission: string): PolicyRule[] {
  const live: PolicyRule[] = [];
  let overridden = false;
  for (let i = ruleset.length - 1; i >= 0; i--) {
    const rule = ruleset[i]!;
    if (!wildcardMatch(permission, rule.permission)) continue;
    if (rule.action === "allow") {
      if (rule.pattern === "*") overridden = true;
    } else if (!overridden) {
      live.unshift(rule);
    }
  }
  return live;
}

/**
 * A data-fed operand (`echo .env | xargs cat`) never reaches a pattern
 * opencode matches, so it stops when a live shell rule could match the
 * receiving command (R1), or when any live `read` rule exists and the command
 * can open a path. A static stop: it happens before the ask bridge prompts.
 */
function unresolvableOperandStop(command: string, ruleset: PolicyRule[], hostMajor: 1 | 2): string | null {
  const entries = commandsWithUnresolvableOperands(command);
  if (entries.length === 0) return null;
  const shellRules = liveRestrictiveRules(ruleset, hostMajor === 2 ? "shell" : "bash")
    .map((rule) => ({ rule, words: tokenizeShellWords(rule.pattern) }));
  const readRule = liveRestrictiveRules(ruleset, "read")[0];
  for (const entry of entries) {
    const hit = shellRules.find(({ words }) => ruleHeadCouldMatch(words, entry.head));
    if (hit) return describeUnresolvableOperand(entry, `your opencode rule ${hit.rule.permission}:${hit.rule.pattern}`);
    if (readRule && operandHeadMayReadPaths(entry.head)) {
      return describeUnresolvableOperand(entry, `your opencode rule ${readRule.permission}:${readRule.pattern}`);
    }
  }
  return null;
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
    const verdict = staticVerdict(requests, ruleset, options.hostMajor);
    if (verdict.action === "deny") return verdict;
    const command = typeof operation === "string" ? operation : operation.tool === "bash" ? operation.command : undefined;
    const fed = typeof command === "string" ? unresolvableOperandStop(command, ruleset, options.hostMajor ?? 1) : null;
    return fed === null ? verdict : { action: "deny", rule: fed };
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
