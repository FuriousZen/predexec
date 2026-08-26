/**
 * Shared steering text for the predexec adapters.
 *
 * Harness-facing (NOT part of pure `core/`) — the constants the adapters
 * import their routing prose from. The two skills (`.pi/skills/predexec/SKILL.md`,
 * `skills/predexec-claude/SKILL.md`) restate the same rules as static markdown
 * and must be updated by hand when this changes.
 */

import { escapeRegExp } from "./core/index.ts";

/** The one-line routing rule opencode injects when the host prompt lacks it. */
export const STEERING_LINE =
  "Use predexec for all read-only shell operations. Use bash only for writes/installs/deletes and interactive commands.";

/**
 * The three DESCRIPTION-opening sentences shared byte-for-byte by the MCP and
 * opencode adapters (what a node runs, how edges branch). pi's DESCRIPTION has
 * already drifted from this — its second sentence lacks the "(parallel:true)"
 * parenthetical — so pi keeps its own local literal rather than composing from
 * this constant; that drift is intentionally NOT corrected here (see CLAUDE.md).
 */
export const DESCRIPTION_BASE =
  "Run read-only shell commands and tool calls with deterministic branching. " +
  "Each node runs shell commands (strings) and/or tool calls ({tool, ...args}) sequentially or concurrently (parallel:true). " +
  "Edges evaluate conditions on output to choose the next node with no model call between levels. ";

/**
 * The "use parallel:true / cwd / edges" usage sentence. Shared by the MCP and
 * opencode DESCRIPTIONs; pi carries the same sentence too, but embedded inside
 * its promptGuidelines rather than its (shorter) DESCRIPTION.
 */
export const USAGE_LINE =
  "Use parallel:true for independent reads, cwd for a shared base dir, and edges to branch. ";

/**
 * The mutationStop/noEdgeMatch recovery sentence. Shared by the MCP and
 * opencode DESCRIPTIONs and by pi's second promptGuidelines entry (there
 * prefixed locally with "predexec: ").
 */
export const RECOVERY_LINE =
  "mutationStop/noEdgeMatch is recoverable — read the transcript and resume with bash. Never retry the same plan blindly. ";

/**
 * The batching nudge appended after a read-only bash/read/grep/glob call.
 * Shared byte-for-byte by the pi and opencode adapters; each prepends its own
 * newline(s) locally rather than baking them into this constant, since the two
 * call sites join it differently.
 */
export const BASH_NUDGE =
  '[predexec] Batch read-only commands in one predexec call: {"root":"a","nodes":[{"id":"a","commands":["cmd1","cmd2"],"parallel":true}]}';

/**
 * The `when:` condition-shorthand teaching sentence in the plan arg
 * description. Shared byte-for-byte by the MCP and opencode adapters; pi
 * teaches the same shorthands through its own JSON-Schema `Condition`/`PlanEdge`
 * definitions instead of a flat string, so it does not consume this constant.
 */
export const WHEN_SYNTAX_LINE =
  'when: "always" | "exit == 0" (ops ==,!=,<,>) | "stdout =~ /regex/" (also stderr, !~) | ' +
  '"file exists <path>" / "file missing <path>", or a {kind,...} condition object. ';

/**
 * Speculate-only-on-verified-facts guideline, appended to both adapters' tool
 * descriptions. Born from a live failure: a model built a 4-node tree on an
 * assumed repo layout, every path missed, and the errors were misdiagnosed as
 * a harness bug. Depth is only cheap when the branches are real.
 */
export const VERIFY_FIRST_LINE =
  "Relative paths resolve against the session directory (the transcript's '# cwd:' header). " +
  "Do not build depth on unverified paths: verify layout in the first node (ls) and gate children with 'file exists' edges.";

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
      return new RegExp(`(?:^|\\W)${escapeRegExp(marker)}(?:\\W|$)`).test(text);
    };
    return STEERING_MARKERS.filter(hit).length >= QUORUM;
  } catch {
    // Never break the chat turn on guard failure; err on the side of injecting.
    return false;
  }
}
