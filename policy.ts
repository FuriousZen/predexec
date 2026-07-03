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
 * Precedence: for each pipeline segment, the LONGEST matching pattern wins
 * (most specific), project config over global on ties. Verified against
 * opencode's object-form `permission.bash` semantics; if opencode's engine
 * diverges, err on the side of stopping — a false stop costs one fallback
 * request, a false run bypasses the user's policy.
 *
 * All reads are exception-safe: malformed/missing config → no rules → allow
 * (a config problem must never break a tool call).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { splitCommandSegments } from "./core/index.ts";

export type PolicyAction = "allow" | "ask" | "deny";

export interface PolicyRule {
  pattern: string;
  action: PolicyAction;
}

const ACTIONS = new Set<PolicyAction>(["allow", "ask", "deny"]);

/** Parse one opencode.json's `permission.bash` into rules; [] on any problem. */
export function parseBashPermission(configText: string): PolicyRule[] {
  try {
    const config = JSON.parse(configText) as { permission?: { bash?: unknown } };
    const bash = config?.permission?.bash;
    if (typeof bash === "string") {
      // String form applies to ALL bash commands. "allow" is the default — no rule.
      return ACTIONS.has(bash as PolicyAction) && bash !== "allow"
        ? [{ pattern: "*", action: bash as PolicyAction }]
        : [];
    }
    if (bash && typeof bash === "object" && !Array.isArray(bash)) {
      const rules: PolicyRule[] = [];
      for (const [pattern, action] of Object.entries(bash)) {
        if (typeof action === "string" && ACTIONS.has(action as PolicyAction)) {
          rules.push({ pattern, action: action as PolicyAction });
        }
      }
      return rules;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Read bash permission rules from the same two locations `bin/predexec.mjs`
 * checks: `<projectDir>/opencode.json`, then `$XDG_CONFIG_HOME/opencode/opencode.json`
 * (default `~/.config/...`). Project rules are listed FIRST so they win ties
 * in the longest-pattern precedence below.
 */
export function readOpencodeBashRules(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): PolicyRule[] {
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const paths = [join(projectDir, "opencode.json"), join(configHome, "opencode", "opencode.json")];
  const rules: PolicyRule[] = [];
  for (const path of paths) {
    try {
      rules.push(...parseBashPermission(readFileSync(path, "utf8")));
    } catch {
      /* missing/unreadable file → no rules from it */
    }
  }
  return rules;
}

/** Convert an opencode permission pattern (`*` wildcards) to an anchored regex. */
function patternToRegex(pattern: string): RegExp | null {
  try {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "[\\s\\S]*");
    return new RegExp(`^${escaped}$`);
  } catch {
    return null;
  }
}

/**
 * Build the `checkCommandPolicy` callback for the engine. Each pipeline
 * segment of the command is judged independently (a compound `git status &&
 * git push` must not smuggle the push past a `git push *` rule); per segment
 * the longest matching pattern wins, earlier rules (project config) win ties.
 * Returns the matched pattern when the winning action is deny/ask, else null.
 */
export function createPolicyChecker(rules: PolicyRule[]): (cmd: string) => string | null {
  if (rules.length === 0) return () => null;
  const compiled = rules
    .map((rule) => ({ ...rule, regex: patternToRegex(rule.pattern) }))
    .filter((rule): rule is PolicyRule & { regex: RegExp } => rule.regex !== null);

  return (cmd: string) => {
    try {
      for (const segment of splitCommandSegments(cmd)) {
        let winner: (PolicyRule & { regex: RegExp }) | null = null;
        for (const rule of compiled) {
          if (!rule.regex.test(segment.trim())) continue;
          if (!winner || rule.pattern.length > winner.pattern.length) winner = rule;
        }
        if (winner && winner.action !== "allow") return winner.pattern;
      }
      return null;
    } catch {
      return null;
    }
  };
}
