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
 * File format: `{ "readOnlyHeads": string[], "allowScripts": string[] }`.
 * A malformed file never throws: it contributes nothing, with a warning.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
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
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: {} };
    return { error: `unreadable (${(err as Error).message})` };
  }
  if (text.length > MAX_CONFIG_BYTES) return { error: `larger than ${MAX_CONFIG_BYTES} bytes` };
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
