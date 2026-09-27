/**
 * predexec user-level configuration (harness-facing, not in core/).
 *
 * The classifier's opt-ins — extra read-only heads, and the D1 allowlist of
 * repository scripts the user trusts to run during speculation — come ONLY
 * from the user: the environment (`PREDEXEC_READONLY_HEADS`,
 * `PREDEXEC_ALLOW_SCRIPTS`, comma-separated) and
 * `$XDG_CONFIG_HOME/predexec/config.json` (default `~/.config/predexec/`).
 * Never from anything under the repository or session root: a repo that could
 * allowlist its own scripts would defeat the rule it is exempting itself from.
 * That is why `loadUserConfig` takes no cwd, and why a relative
 * `XDG_CONFIG_HOME` (which would resolve against the cwd) is ignored, as the
 * XDG spec requires.
 *
 * R63: the repository can still reach these sources indirectly — a config
 * path that resolves inside the session root, or (on Claude Code) a project
 * settings `env` block that sets the variables (HOME included), or a relative
 * HOME/XDG_CONFIG_HOME resolved against its cwd (R68). `sessionTrustProblem`
 * detects each, and the adapter runtime then disables the allowlists (fail
 * closed).
 *
 * File format: `{ "readOnlyHeads": string[], "allowScripts": string[] }`.
 * A malformed file never throws: it contributes nothing, with a warning.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ClassifierOptions } from "./core/index.ts";

export interface UserConfig {
  classifier: ClassifierOptions;
  warnings: string[];
}

/** Largest config file read; anything bigger is malformed. */
const MAX_CONFIG_BYTES = 64 * 1024;

const FILE_KEYS = { readOnlyHeads: "extraReadOnlyHeads", allowScripts: "allowScripts" } as const;
type FileKey = keyof typeof FILE_KEYS;

/** `$XDG_CONFIG_HOME/predexec/config.json`, or `$HOME/.config/…` when unset or relative. */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME || homedir(), ".config");
  return join(base, "predexec", "config.json");
}

function envList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/** The file's entries, or a reason it is malformed. Missing file = no entries. */
function readConfigFile(path: string): { entries: Partial<Record<FileKey, string[]>> } | { error: string } {
  // Stat before reading: a FIFO would block the read forever and a special
  // or huge file would read unboundedly.
  let text: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { error: "not a regular file" };
    if (stat.size > MAX_CONFIG_BYTES) return { error: `larger than ${MAX_CONFIG_BYTES} bytes` };
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: {} };
    return { error: `unreadable (${(err as Error).message})` };
  }
  // Re-checked in bytes: the file may have grown between stat and read.
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) return { error: `larger than ${MAX_CONFIG_BYTES} bytes` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `not valid JSON (${(err as Error).message})` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "not a JSON object" };
  const entries: Partial<Record<FileKey, string[]>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(FILE_KEYS, key)) return { error: `unknown key "${key}"` };
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      return { error: `"${key}" must be an array of strings` };
    }
    entries[key as FileKey] = value.map((entry: string) => entry.trim()).filter((entry: string) => entry !== "");
  }
  return { entries };
}

/**
 * Load the user's classifier options: env entries first, then the config
 * file's, merged. Never throws; problems come back as warnings.
 */
export function loadUserConfig(env: NodeJS.ProcessEnv = process.env): UserConfig {
  const warnings: string[] = [];
  const merged: Record<FileKey, string[]> = {
    readOnlyHeads: envList(env.PREDEXEC_READONLY_HEADS),
    allowScripts: envList(env.PREDEXEC_ALLOW_SCRIPTS),
  };
  let path: string | null = null;
  try {
    path = userConfigPath(env);
  } catch (err) {
    warnings.push(`predexec: could not locate the user config (${(err as Error).message}); ignoring it`);
  }
  if (path !== null) {
    const file = readConfigFile(path);
    if ("error" in file) {
      warnings.push(`predexec: ignoring ${path}: ${file.error}`);
    } else {
      for (const key of Object.keys(FILE_KEYS) as FileKey[]) merged[key].push(...(file.entries[key] ?? []));
    }
  }
  const classifier: { -readonly [K in keyof ClassifierOptions]: ClassifierOptions[K] } = {};
  for (const key of Object.keys(FILE_KEYS) as FileKey[]) {
    const unique = [...new Set(merged[key])];
    if (unique.length > 0) classifier[FILE_KEYS[key]] = unique;
  }
  return { classifier, warnings };
}

/**
 * The environment keys that choose the user's allowlists: a repository that
 * sets one picks what speculation may run. HOME (R68) picks the default
 * config directory.
 */
const ALLOWLIST_ENV_KEYS = ["PREDEXEC_READONLY_HEADS", "PREDEXEC_ALLOW_SCRIPTS", "XDG_CONFIG_HOME", "HOME"] as const;

/** Largest Claude project settings file inspected; bigger fails closed. */
const MAX_SETTINGS_BYTES = 1024 * 1024;

/** `path` with its longest existing prefix resolved through symlinks. */
function canonical(path: string): string {
  const absolute = resolve(path);
  const tail: string[] = [];
  let dir = absolute;
  for (;;) {
    try {
      return join(realpathSync(dir), ...tail.reverse());
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return absolute;
      tail.push(basename(dir));
      dir = parent;
    }
  }
}

/** R68: only a `..` path component leaves the root; a name like `..x` is inside it. */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (isAbsolute(rel)) return false;
  return !(rel === ".." || rel.startsWith(`..${sep}`));
}

/** The allowlist env keys a Claude settings file's `env` block sets, or an error. */
function settingsEnvKeys(path: string): string[] | { error: string } {
  let text: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { error: "not a regular file" };
    if (stat.size > MAX_SETTINGS_BYTES) return { error: "too large" };
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return { error: (err as Error).message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "not a JSON object" };
  const env = (parsed as Record<string, unknown>).env;
  if (env === undefined) return [];
  if (typeof env !== "object" || env === null) return { error: "env is not an object" };
  return ALLOWLIST_ENV_KEYS.filter((key) => Object.hasOwn(env, key));
}

/**
 * R63: why the user's allowlists cannot be trusted for this session, or null.
 * (a) the resolved config file lies inside the session root, or HOME or
 * XDG_CONFIG_HOME is relative (R68); (b) on Claude
 * Code, `<root>/.claude/settings.json` or `settings.local.json` sets one of
 * ALLOWLIST_ENV_KEYS in its `env` block (an unreadable one fails closed).
 * An approved repo-scoped MCP registration chooses the server command itself,
 * so its env block is outside this check (and outside predexec's containment).
 */
export function sessionTrustProblem(input: { sessionRoot: string; host?: string; env?: NodeJS.ProcessEnv }): string | null {
  const env = input.env ?? process.env;
  const root = canonical(input.sessionRoot);
  // R68: a relative HOME or XDG_CONFIG_HOME resolves against a cwd the
  // repository controls (userConfigPath ignores a relative XDG_CONFIG_HOME,
  // but its presence still says something set it); fail closed.
  for (const key of ["HOME", "XDG_CONFIG_HOME"] as const) {
    const value = env[key];
    if (value && !isAbsolute(value)) return `${key} is a relative path (${value})`;
  }
  let path: string;
  try {
    path = canonical(userConfigPath(env));
  } catch (err) {
    return `the user config could not be located (${(err as Error).message})`;
  }
  if (inside(root, path)) return `the user config ${path} is inside the session root ${root}`;
  if (input.host === "claude-code") {
    for (const name of ["settings.json", "settings.local.json"]) {
      const file = join(root, ".claude", name);
      const keys = settingsEnvKeys(file);
      if ("error" in keys) return `${file} could not be read (${keys.error})`;
      if (keys.length > 0) return `${file} sets ${keys.join(", ")} in its env block`;
    }
  }
  return null;
}
