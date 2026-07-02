/**
 * Shared steering text for the predexec adapters.
 *
 * Harness-facing (NOT part of pure `core/`) — the one place the adapters and the
 * pi skill draw their routing prose from, so pi (skill), opencode (guarded system
 * push + AGENTS.md), and the tool guidelines never drift.
 *
 * pi loads its steering declaratively from `skills/predexec/SKILL.md`; opencode has
 * no plugin-skill loader, so it injects STEERING_LINE via system.transform ONLY when
 * the host isn't already carrying it (detected via STEERING_MARKER).
 */

/** The one-line routing rule opencode injects when the host prompt lacks it. */
export const STEERING_LINE =
  "Use predexec for all read-only shell operations. Use bash only for writes/installs/deletes and interactive commands.";

/**
 * Distinctive token that identifies predexec routing rules already present in the
 * system prompt (e.g. via a host-loaded AGENTS.md/CLAUDE.md). If any system entry
 * contains it, opencode skips its own injection to avoid duplication.
 */
export const STEERING_MARKER = "predexec";

/** True when the system prompt entries already carry predexec routing instructions. */
export function systemHasRoutingInstructions(system: string[]): boolean {
  return system.some((s) => typeof s === "string" && s.includes(STEERING_MARKER));
}
