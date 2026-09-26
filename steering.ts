/**
 * Shared steering text for the predexec adapters.
 *
 * Harness-facing (NOT part of pure `core/`) — the constants the adapters
 * import their routing prose from. Every harness's routing SKILL.md is
 * RENDERED from these constants by `renderSkill` (`pnpm skills` writes them to
 * `SKILL_PATHS`); never edit a SKILL.md by hand — __tests__/skills.test.ts
 * fails on drift.
 */

import { escapeRegExp } from "./core/index.ts";
import { TOOL_OP_SYNTAX } from "./plan-language.ts";
export { JSON_PATH_SINGLE_OP_LINE } from "./plan-language.ts";

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
 * opencode DESCRIPTIONs; pi carries it through the rendered skill rather than
 * its (shorter) DESCRIPTION.
 */
export const USAGE_LINE =
  "Use parallel:true for independent reads, cwd for a shared base dir, and edges to branch. ";

/**
 * The mutationStop/noEdgeMatch recovery sentence. Shared by the MCP and
 * opencode DESCRIPTIONs and by every rendered skill.
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

// ---------------------------------------------------------------------------
// Skill rendering — one source for every harness's routing SKILL.md.
// ---------------------------------------------------------------------------

export const SKILL_HARNESSES = ["pi", "claude", "codex", "opencode", "antigravity"] as const;
export type SkillHarness = (typeof SKILL_HARNESSES)[number];

/**
 * Repo-relative output path per harness. Each lives in its own subtree so a
 * host's recursive `**\/SKILL.md` scan of one plugin's skills dir never picks
 * up another harness's skill. pi's is found through package.json `pi.skills`;
 * Antigravity's is written straight into its plugin dir.
 */
export const SKILL_PATHS: Readonly<Record<SkillHarness, string>> = Object.freeze({
  pi: ".pi/skills/predexec/SKILL.md",
  claude: "skills/claude/predexec/SKILL.md",
  codex: "skills/codex/predexec/SKILL.md",
  opencode: "skills/opencode/predexec/SKILL.md",
  antigravity: "antigravity-plugin/skills/predexec/SKILL.md",
});

/** Always-resident: the frontmatter description every host keeps in context. */
const SKILL_DESCRIPTION =
  STEERING_LINE +
  " Use it for ls/cat/grep/find-style reads, read/grep/find/ls tool calls, and predictable multi-step read sequences " +
  "(one plan tree, one round-trip); it hard-stops before anything that mutates.";

/** Where the tool id comes from — MCP hosts namespace it, so never hardcode the full id. */
const MCP_TOOL_ID_LINE =
  "Call the `predexec` tool (its full id varies by install, e.g. `mcp__predexec__predexec` or a plugin-namespaced id).";

/**
 * Per-harness permission behavior (carries the `policyStop` token). pi has no
 * permission layer predexec consults, so it gets none.
 */
const POLICY_PARAGRAPH: Readonly<Record<SkillHarness, string | null>> = Object.freeze({
  pi: null,
  claude:
    "Permissions: shell commands and read/grep/find/ls tool ops are re-checked against your Claude Code permission rules. " +
    "A deny OR ask match hard-stops the walk (`policyStop`), because predexec cannot prompt mid-walk — run that step with your own Bash/Read tool instead. " +
    "`Read(...)` deny rules use gitignore-style paths and also cover shell readers (cat, head, …).",
  codex:
    "Permissions: shell commands are re-checked against your Codex execpolicy rules (`/etc/codex/rules`, `~/.codex/rules`, and a trusted project's `.codex/rules`; most-restrictive wins). " +
    "A forbidden OR prompt match hard-stops the walk (`policyStop`), because predexec cannot prompt mid-walk — run that step with your own shell tool instead. " +
    "An unreadable rules file stops every shell command until it is fixed. " +
    "read/grep/find/ls tool ops are not host-policy mapped (Codex has no persisted file-operation policy).",
  opencode:
    "Permissions: shell commands and read/grep/find/ls tool ops respect your opencode permission rules. " +
    "A static deny stops immediately (`policyStop`). On opencode 1.x an ask is forwarded to opencode's own permission service, so the user may be prompted mid-walk, and a rejection stops the walk. " +
    "On opencode 2.x plugins cannot prompt, so an ask match hard-stops the walk — run that step with the host's own tool (`shell`/`read`) instead. " +
    "Known gap: rules visible only to the host are not applied to inner `sh -c` spellings.",
  antigravity:
    "Permissions: shell commands and file reads are re-checked against your Antigravity grants (`command(...)` / `read_file(...)`, Deny > Ask > Allow). " +
    "A deny OR ask match hard-stops the walk (`policyStop`), because predexec cannot prompt mid-walk — run that step with your own tools instead.",
});

/** The host's own shell tool, named the way that host names it. */
const SHELL_TOOL: Readonly<Record<SkillHarness, string>> = Object.freeze({
  pi: "bash",
  claude: "Bash",
  codex: "your shell tool",
  opencode: "bash",
  antigravity: "your terminal tool",
});

const HARNESS_TITLE: Readonly<Record<SkillHarness, string>> = Object.freeze({
  pi: "pi",
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  antigravity: "Antigravity",
});

/** Hosts whose tool ops are predexec's own filesystem code (the MCP tool-ops module). */
const OWN_TOOL_OPS: ReadonlySet<SkillHarness> = new Set<SkillHarness>(["claude", "codex", "antigravity"]);

/**
 * Render one harness's complete SKILL.md (frontmatter + body). Pure and
 * deterministic: `scripts/gen-skills.mjs` writes this to `SKILL_PATHS[h]`.
 */
export function renderSkill(h: SkillHarness): string {
  const shell = SHELL_TOOL[h];
  const policy = POLICY_PARAGRAPH[h];
  const bullets = [
    OWN_TOOL_OPS.has(h) ? MCP_TOOL_ID_LINE : "Call the `predexec` tool.",
    USAGE_LINE.trim(),
    `A node's \`commands\` mixes shell strings and tool ops: \`${TOOL_OP_SYNTAX}\`.`,
    `Edge conditions — ${WHEN_SYNTAX_LINE.trim()}`,
    VERIFY_FIRST_LINE.trim(),
    "predexec hard-stops (`mutationStop`) before any write/install/delete/exec — including interpreter one-liners that write, " +
      `shell scripts (\`bash x.sh\`), and \`sh -c\` with writes. Run those, and interactive commands, with ${shell}.`,
    ...(policy ? [policy] : []),
    RECOVERY_LINE.trim() +
      (policy ? " `policyStop` recovers the same way." : "") +
      (shell.toLowerCase() === "bash" ? "" : ` ("bash" here means ${shell}.)`),
    "A tool op exiting 2 means the search never ran (bad path or scope); exit 1 means it ran and found nothing.",
    "Truncated output is always flagged (`…[truncated`) — never branch on it as if it were complete.",
    ...(OWN_TOOL_OPS.has(h)
      ? [
          "predexec's read/grep/find/ls are its own filesystem implementations, not the host's native tools — line numbering, " +
            "truncation and .gitignore handling differ. Use the native tool when exact fidelity matters.",
        ]
      : []),
  ];
  const text =
    `---\nname: predexec\ndescription: ${SKILL_DESCRIPTION}\n---\n\n` +
    `# predexec routing (${HARNESS_TITLE[h]})\n\n` +
    bullets.map((b) => `- ${b}`).join("\n") +
    "\n";
  return text;
}
