/**
 * predexec — opencode adapter logic shared by the v1 (`server`) and v2
 * (`setup`) plugin shims. See ../plugins/predexec.ts for the v1 hooks and
 * ./v2.ts for the v2 registrations; both stay thin over this module.
 *
 * Lives outside `.opencode/plugins/` on purpose: opencode auto-discovers every
 * direct child of a `plugin`/`plugins` dir as a plugin (v1: legacy discovery;
 * v2: core `plugin/source-directory.ts:7-33`), so a helper module there would
 * be loaded — and rejected — as a plugin of its own.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDestructiveCommand, type OperationPolicyChecker, type RunOptions } from "../../core/index.ts";
import { executeAdapterPlan } from "../../adapter-runtime.ts";
import {
  DESCRIPTION_BASE,
  RECOVERY_LINE,
  USAGE_LINE,
  VERIFY_FIRST_LINE,
} from "../../steering.ts";
import { createOpencodeAskBridge, createPolicyChecker, readOpencodeRuleset, type OpencodeAsk } from "../../policy.ts";

export const DESCRIPTION =
  DESCRIPTION_BASE +
  USAGE_LINE +
  RECOVERY_LINE +
  "Shell and mapped file operations respect your opencode permission rules — a deny stops before running; an ask prompts through opencode when it can, else stops. " +
  VERIFY_FIRST_LINE;

export const errText = (e: unknown): string =>
  typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);

/**
 * Walks up from `startDir` to the nearest ancestor directory whose
 * `package.json` declares `"name": "predexec"`, rather than counting a fixed
 * number of `..` segments. This file lives at `.opencode/lib/shared.ts` in a
 * source checkout (package root two levels up) but at
 * `dist/.opencode/lib/shared.js` in an npm install (package root three levels
 * up) — a fixed-depth relative path silently breaks the moment either layout
 * changes; resolving by content is layout-independent.
 */
function findPackageRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg && pkg.name === "predexec") return dir;
    } catch {
      // No package.json at this level, or it's unreadable/malformed — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root without a match
    dir = parent;
  }
}

/**
 * Absolute path to the packaged opencode skill directory (`skills/opencode`,
 * containing `predexec/SKILL.md`), or null if the package root couldn't be
 * located or the directory doesn't exist on disk. Computed once at module
 * load — this file's own location never changes at runtime.
 */
export const PACKAGED_OPENCODE_SKILL_DIR: string | null = (() => {
  const root = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (!root) return null;
  const dir = join(root, "skills", "opencode");
  return existsSync(dir) ? dir : null;
})();

/**
 * Whether the post-tool nudge applies: opencode's native read-only tools
 * (`read`/`grep`/`glob`), or its shell tool (`bash` on v1, `shell` on v2 —
 * core `tool/plugin/shell.ts:22`) running a non-destructive command.
 */
export function shouldNudge(tool: string, command: unknown): boolean {
  if (["read", "grep", "glob"].includes(tool)) return true;
  if (tool === "bash" || tool === "shell") {
    return typeof command === "string" && command !== "" && !isDestructiveCommand(command);
  }
  return false;
}

export interface PolicyInput {
  /** Session root the ruleset is read for and operations are resolved against. */
  directory: string;
  worktree?: string;
  agent?: string;
  /** The host's permission prompt, when it offers one (opencode v1 `context.ask`). */
  ask?: OpencodeAsk;
  signal: AbortSignal;
  hostMajor: 1 | 2;
}

/**
 * Builds this call's policy seam. Re-read per call (a few small JSON reads):
 * config edits apply immediately. One bridge per call = one walk, so its dedupe
 * and stop-after-rejection state never leaks across tool calls. Without `ask`
 * the static checker is the whole check, and both deny and ask hard-stop.
 */
export function createOperationPolicy(input: PolicyInput): OperationPolicyChecker {
  const ruleset = readOpencodeRuleset(input.directory, process.env, {
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.worktree ? { worktree: input.worktree } : {}),
    hostMajor: input.hostMajor,
  });
  const checkerOptions = { directory: input.directory, ...(input.worktree ? { worktree: input.worktree } : {}) };
  return input.ask
    ? createOpencodeAskBridge(input.ask, ruleset, { ...checkerOptions, signal: input.signal })
    : createPolicyChecker(ruleset, checkerOptions);
}

/** Runs one plan and returns the transcript opencode shows the model. */
export async function runPlan(
  plan: unknown,
  options: Pick<RunOptions, "cwd" | "signal" | "executeToolOp" | "checkOperationPolicy">,
): Promise<string> {
  const result = await executeAdapterPlan(plan, "opencode", options);
  return result.transcript || "(no output)";
}
