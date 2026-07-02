/**
 * Shared steering text for the predexec adapters.
 *
 * Harness-facing (NOT part of pure `core/`) — the one place the adapters and the
 * pi skill draw their routing prose from, so pi (skill), opencode (guarded system
 * push + AGENTS.md), and the tool guidelines never drift.
 *
 * pi loads its steering declaratively from `skills/predexec/SKILL.md`; opencode has
 * no plugin-skill loader, so it injects STEERING_LINE via system.transform ONLY when
 * the host isn't already carrying routing rules (detected via a STEERING_MARKERS
 * quorum — see systemHasRoutingInstructions).
 */

/** The one-line routing rule opencode injects when the host prompt lacks it. */
export const STEERING_LINE =
  "Use predexec for all read-only shell operations. Use bash only for writes/installs/deletes and interactive commands.";

/**
 * Quorum markers identifying predexec ROUTING RULES (not mere mentions of the
 * name) already present in the system prompt — e.g. via a host-loaded
 * AGENTS.md/CLAUDE.md. Any 2 of 3 confirm the rules are present and opencode
 * skips its own injection.
 *
 * Markers must NOT be substrings of each other. A single bare "predexec" marker
 * is NOT enough on its own: a project doc that merely names the tool (like this
 * repo's own CLAUDE.md) would otherwise silently disable steering.
 */
export const STEERING_MARKERS = [
  "read-only shell operations", // distinctive phrase from STEERING_LINE
  "predexec", // tool name (word-boundary matched)
  "mutationStop", // distinctive routing-bullet token
] as const;

const QUORUM = 2;

/** Escape a marker for literal use inside a RegExp. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when the system prompt entries already carry predexec routing
 * instructions (≥2 marker hits). Single-token markers are word-boundary
 * matched so identifiers like "mypredexec" don't count; the multi-word
 * phrase is matched as a plain substring. Total and exception-safe.
 */
export function systemHasRoutingInstructions(system: string[]): boolean {
  try {
    const text = system.filter((s) => typeof s === "string").join("\n");
    const hit = (marker: string): boolean => {
      if (marker.includes(" ")) return text.includes(marker);
      return new RegExp(`(?:^|\\W)${escapeRe(marker)}(?:\\W|$)`).test(text);
    };
    return STEERING_MARKERS.filter(hit).length >= QUORUM;
  } catch {
    // Never break the chat turn on guard failure; err on the side of injecting.
    return false;
  }
}
