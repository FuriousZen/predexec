/**
 * predexec policy — opencode host-permission reader/checker.
 *
 * Harness-facing (NOT part of pure `core/`): fs + env access lives here, like
 * steering.ts/stats.ts. Closes the policy-bypass hole: predexec spawns shell
 * strings directly, so without this a user's opencode `permission.bash` rules
 * (deny/ask) never see them. The opencode adapter builds a checker per tool
 * call and passes it as `RunOptions.checkCommandPolicy`; the engine hard-stops
 * (`policyStop`) BEFORE running a matched command.
 *
 * Both `deny` AND `ask` stop: predexec cannot prompt mid-walk, and silently
 * running a command the host would have prompted for is exactly the hole being
 * closed. `allow` rules participate in precedence so a specific allow can
 * override a broad ask/deny (e.g. `"*": "ask"` + `"git log*": "allow"`).
 *
 * Precedence: for each pipeline segment, the LAST matching rule wins, matching
 * opencode exactly — "Rules are evaluated by pattern match, with the last
 * matching rule winning" (https://opencode.ai/docs/permissions/). This used to
 * be longest-pattern-wins, which inverted the result for the documented
 * catch-all-first idiom: `{"git *":"allow","*":"deny"}` denies everything under
 * opencode but resolved to `allow` here, so predexec ran commands the host
 * would have blocked.
 *
 * Config discovery mirrors opencode: it walks up from the project dir, reads
 * `opencode.json` and `opencode.jsonc` (comments are legal and a bare
 * JSON.parse silently yielded zero rules → allow-everything), and merges global
 * under project by insertion order so last-wins still holds after the merge.
 *
 * Reads are exception-safe, but a config that EXISTS and fails to parse is
 * treated as unknown → stop, not as absent → allow. An unreadable policy is
 * exactly when guessing "allow" is least defensible.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import { splitCommandSegments } from "./core/index.ts";

export type PolicyAction = "allow" | "ask" | "deny";

export interface PolicyRule {
  pattern: string;
  action: PolicyAction;
}

const ACTIONS = new Set<PolicyAction>(["allow", "ask", "deny"]);

const isAction = (v: unknown): v is PolicyAction => typeof v === "string" && ACTIONS.has(v as PolicyAction);

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
 * Parse one config's bash permission into ordered rules.
 *
 * Handles all documented shapes: the string shorthand (`"permission": "deny"`),
 * the tool-keyed object (`{"bash": "ask"}`), the granular pattern object
 * (`{"bash": {"*": "ask", "git *": "allow"}}`), and the `"*"` tool fallback
 * (`{"*": "deny"}`) which applies to bash when no `bash` key is present.
 * Throws on malformed JSON so the caller can fail closed.
 */
export function parseBashPermission(configText: string): PolicyRule[] {
  const config = JSON.parse(stripJsonComments(configText)) as { permission?: unknown };
  const permission = config?.permission;
  if (permission === undefined || permission === null) return [];

  // `"permission": "deny"` — a bare string applies to everything.
  if (isAction(permission)) return permission === "allow" ? [] : [{ pattern: "*", action: permission }];
  if (typeof permission !== "object" || Array.isArray(permission)) return [];

  const perm = permission as Record<string, unknown>;
  // A `bash` key wins; otherwise the `*` tool-level fallback applies to bash.
  const bash = perm.bash ?? perm["*"];
  if (bash === undefined) return [];

  if (isAction(bash)) return bash === "allow" ? [] : [{ pattern: "*", action: bash }];

  if (typeof bash === "object" && !Array.isArray(bash)) {
    const rules: PolicyRule[] = [];
    // Insertion order IS the precedence order — preserve it exactly.
    for (const [pattern, action] of Object.entries(bash as Record<string, unknown>)) {
      if (isAction(action)) rules.push({ pattern, action });
    }
    return rules;
  }
  return [];
}

/** Config files opencode reads, nearest-last so project overrides global. */
export function opencodeConfigPaths(projectDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const paths = [join(configHome, "opencode", "opencode.json"), join(configHome, "opencode", "opencode.jsonc")];

  // opencode walks up from the cwd to the worktree root. Collect nearest LAST so
  // the closest config's rules land last and therefore win under last-wins.
  const chain: string[] = [];
  const root = parsePath(projectDir).root;
  let dir = projectDir;
  for (;;) {
    chain.push(
      join(dir, "opencode.json"),
      join(dir, "opencode.jsonc"),
      join(dir, ".opencode", "opencode.json"),
      join(dir, ".opencode", "opencode.jsonc"),
    );
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  paths.push(...chain.reverse());

  const explicit = env.OPENCODE_CONFIG;
  if (explicit) paths.push(explicit);
  return paths;
}

/**
 * Read bash permission rules across every config opencode would consult.
 *
 * `unreadable` reports configs that exist but failed to parse. The caller fails
 * closed on those: a policy file we cannot read is the worst possible moment to
 * assume "allow".
 */
export function readOpencodeBashRules(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { rules: PolicyRule[]; unreadable: string[] } {
  const rules: PolicyRule[] = [];
  const unreadable: string[] = [];
  for (const path of opencodeConfigPaths(projectDir, env)) {
    if (!existsSync(path)) continue;
    try {
      rules.push(...parseBashPermission(readFileSync(path, "utf8")));
    } catch {
      unreadable.push(path);
    }
  }
  return { rules, unreadable };
}

/**
 * Convert an opencode permission pattern to an anchored regex.
 * `*` matches zero or more characters, `?` exactly one
 * (https://opencode.ai/docs/permissions/).
 */
function patternToRegex(pattern: string): RegExp | null {
  try {
    const escaped = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\*/g, "[\\s\\S]*")
      .replace(/\\\?/g, "[\\s\\S]");
    return new RegExp(`^${escaped}$`);
  } catch {
    return null;
  }
}

/**
 * Build the `checkCommandPolicy` callback for the engine.
 *
 * Each pipeline segment is judged independently, so a compound
 * `git status && git push` cannot smuggle the push past a `git push *` rule.
 * Within a segment the LAST matching rule wins, exactly as opencode evaluates
 * them. Returns the matched pattern when the winning action is deny/ask, else
 * null.
 *
 * `unreadable` config paths stop everything: we know a policy exists and we
 * could not read it, so running anything would be guessing.
 */
export function createPolicyChecker(
  rules: PolicyRule[],
  unreadable: string[] = [],
): (cmd: string) => string | null {
  if (unreadable.length > 0) {
    // Name the file and the remedy: without that this reads as a predexec bug
    // rather than a syntax error in the user's own config.
    const why =
      `cannot read your opencode permission rules (${unreadable[0]} is not valid JSON/JSONC) — ` +
      `predexec stops rather than run commands your policy might forbid; fix that file to continue`;
    return () => why;
  }
  if (rules.length === 0) return () => null;
  const compiled = rules
    .map((rule) => ({ ...rule, regex: patternToRegex(rule.pattern) }))
    .filter((rule): rule is PolicyRule & { regex: RegExp } => rule.regex !== null);

  return (cmd: string) => {
    try {
      for (const segment of splitCommandSegments(cmd)) {
        const trimmed = segment.trim();
        let winner: (PolicyRule & { regex: RegExp }) | null = null;
        // Last match wins — keep scanning rather than breaking on first hit.
        for (const rule of compiled) {
          if (rule.regex.test(trimmed)) winner = rule;
        }
        if (winner && winner.action !== "allow") return winner.pattern;
      }
      return null;
    } catch {
      return null;
    }
  };
}
