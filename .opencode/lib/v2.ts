/**
 * predexec — opencode v2 (2.0.x) plugin shim.
 *
 * opencode 2.x loads a plugin module's default export as `{ id, setup }`
 * (core `plugin/module.ts:60-73`; the v1 `{ id, server }` shape is rejected
 * with `PluginModule.LoadError`). `setup(ctx)` registers everything
 * imperatively through the Promise plugin context (`@opencode/plugin`
 * `promise/plugin.ts:26-61`). Citations are into opencode tag `v2.0.16`; see
 * docs/research/opencode-v2-plugins.md for the full contract.
 *
 * What maps, and how:
 *  - tool: `ctx.tool.transform(editor => editor.add({...}))`. The input schema
 *    is a PLAIN JSON Schema object (`Tool.ValueSchema` accepts one,
 *    schema `tool.ts:44`) — no zod crosses into the host, whose pinned zod
 *    4.1.8 otherwise converts a zod schema via a cross-instance `instanceof
 *    $ZodType` (core `tool/runtime.ts:165-169`). `codemode: false` keeps the
 *    tool on the provider's native list (v2 defaults plugin tools INTO
 *    CodeMode's `execute` meta-tool — core `tool.ts:234-235`).
 *  - skill: `ctx.skill.transform(editor => editor.add(Skill.Info))` with the
 *    packaged SKILL.md parsed the way v2's own directory loader does
 *    (core `config/plugin/skill-file.ts:34-55`). v2 has no `config` hook, so
 *    v1's `cfg.skills.paths` mutation has no equivalent.
 *  - steering fallback: `ctx.session.hook("context", ...)` — fired only for the
 *    primary agent loop (title/generate/compaction have their own hooks, core
 *    `session/model-request.ts:378-387`), so v1's sessionID guard is moot.
 *  - post-tool nudge: `ctx.tool.hook("execute.after", ...)`.
 *
 * Degraded, explicitly:
 *  - permissions: the v2 tool context carries no `ask` (schema `tool.ts:14-20`,
 *    plugin `promise/tool.ts:11-14`), and `ctx.permission` exposes only
 *    list/get/reply of pending requests. The static reader is the whole check,
 *    so a deny OR ask rule hard-stops (fail-closed) — never a prompt. The
 *    ruleset is built with v2's own model (`readOpencodeRuleset(..., {hostMajor: 2})`:
 *    per-document concatenation, discovery to the filesystem root, native
 *    `permissions` evaluated); an unparseable source stops everything.
 *  - native tool ops: the v2 plugin context exposes no file/find API, so
 *    read/grep/find/ls run through ../../mcp/tool-ops.ts (node:fs, rg/fd as
 *    accelerators) — the same executor as Claude Code / Codex, with its exit
 *    conventions (1 = ran, found nothing; 2 = never ran, for every op).
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createToolExecutor } from "../../mcp/tool-ops.ts";
import { PLAN_SHAPE_DESCRIPTION } from "../../plan-language.ts";
import { BASH_NUDGE, STEERING_LINE, WHEN_SYNTAX_LINE, systemHasRoutingInstructions } from "../../steering.ts";
import {
  DESCRIPTION,
  PACKAGED_OPENCODE_SKILL_DIR,
  createOperationPolicy,
  errText,
  runPlan,
  shouldNudge,
} from "./shared.ts";

const PLAN_ARG_DESCRIPTION =
  PLAN_SHAPE_DESCRIPTION +
  WHEN_SYNTAX_LINE +
  "Note: tool ops read the filesystem directly (opencode v2 gives plugins no file API), paths may not escape the session root, " +
  "grep/find fall back to a pure-Node walk that ignores .gitignore when ripgrep/fd are absent, " +
  "and exit codes are: 1 = ran, found nothing (a grep/find with no matches); 2 = never ran, for every op (read/ls included).";

/**
 * Local structural stand-ins for the slice of `@opencode/plugin` (v2 Promise
 * API) this shim touches — the package is not a dependency, same rule as the
 * v1 shim. Loosely typed on purpose: only what is read or called here.
 */
type Registration = { dispose: () => Promise<void> };
type Transform<Editor> = (callback: (editor: Editor) => void) => Promise<Registration>;

type V2Result = { content: string };
type V2ToolContext = { agent?: string; signal: AbortSignal };
type V2ToolInfo = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { codemode: false };
  execute: (input: { plan?: unknown }, context: V2ToolContext) => Promise<V2Result>;
};
type V2SkillInfo = { id: string; name: string; description?: string; path: string; content: string };
type SystemPart = { type: "text"; text: string };
type ToolAfterEvent = { tool: string; input: unknown } & (
  | { status: "completed"; result: { content?: string | ReadonlyArray<unknown> } & Record<string, unknown> }
  | { status: "error" }
);

export type V2PluginContext = {
  location: { directory: string; project?: { directory?: string } };
  tool: {
    transform: Transform<{ add(tool: V2ToolInfo): void }>;
    hook(name: "execute.after", callback: (event: ToolAfterEvent) => void | Promise<void>): Promise<Registration>;
  };
  skill: { transform: Transform<{ add(skill: V2SkillInfo): void }> };
  session: {
    hook(name: "context", callback: (event: { system: SystemPart[] }) => void | Promise<void>): Promise<Registration>;
  };
};

/**
 * Parses the packaged `SKILL.md` into v2's `Skill.Info`: id from the parent
 * directory, `name`/`description` from simple `key: value` frontmatter lines,
 * `content` the body after the closing fence. Returns null (skill skipped) on
 * anything unexpected — the tool still registers.
 */
export function readPackagedSkill(skillDir: string | null = PACKAGED_OPENCODE_SKILL_DIR): V2SkillInfo | null {
  if (!skillDir) return null;
  const path = join(skillDir, "predexec", "SKILL.md");
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return null;
  const field = (key: string): string | undefined => {
    const line = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "m").exec(match[1] ?? "")?.[1];
    return line?.replace(/^(["'])(.*)\1$/, "$2");
  };
  const id = basename(dirname(path));
  const description = field("description");
  return {
    id,
    name: field("name") ?? id,
    ...(description === undefined ? {} : { description }),
    path,
    content: text.slice(match[0].length),
  };
}

/**
 * The v2 entry. Never uses `this`: v2 decodes the default export through an
 * Effect Schema that strips unknown keys and calls `setup` off the decoded copy.
 */
export async function setupV2(ctx: V2PluginContext): Promise<void> {
  const directory = ctx.location.directory;
  const projectDirectory = ctx.location.project?.directory;
  const worktree = typeof projectDirectory === "string" && projectDirectory !== "" ? projectDirectory : undefined;
  // Built once per Location: PATH (for rg/fd) and the session root are fixed for its life.
  const executeToolOp = createToolExecutor({ cwd: directory });

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "predexec",
      description: DESCRIPTION,
      input: {
        type: "object",
        properties: { plan: { description: PLAN_ARG_DESCRIPTION } },
        required: ["plan"],
      },
      options: { codemode: false },
      async execute(input, context) {
        const checkOperationPolicy = createOperationPolicy({
          directory,
          ...(worktree ? { worktree } : {}),
          ...(typeof context.agent === "string" ? { agent: context.agent } : {}),
          signal: context.signal,
          hostMajor: 2,
        });
        const content = await runPlan(input.plan, {
          cwd: directory,
          signal: context.signal,
          executeToolOp,
          checkOperationPolicy,
        });
        return { content };
      },
    });
  });

  // A malformed packaged skill must not cost the tool registration above.
  let skill: V2SkillInfo | null = null;
  try {
    skill = readPackagedSkill();
  } catch (err) {
    console.error(`[predexec] could not read the packaged opencode skill: ${errText(err)}`);
  }
  if (skill) {
    const info = skill;
    await ctx.skill.transform((editor) => editor.add(info));
  }

  await ctx.session.hook("context", (event) => {
    const texts = event.system.map((part) => (typeof part?.text === "string" ? part.text : ""));
    if (!systemHasRoutingInstructions(texts)) event.system.push({ type: "text", text: STEERING_LINE });
  });

  await ctx.tool.hook("execute.after", (event) => {
    if (event.status !== "completed") return;
    const command = (event.input as { command?: unknown } | null | undefined)?.command;
    if (!shouldNudge(event.tool, command)) return;
    const nudge = "\n" + BASH_NUDGE;
    const content = event.result.content;
    if (typeof content === "string") {
      event.result = { ...event.result, content: content + nudge };
    } else if (Array.isArray(content)) {
      event.result = { ...event.result, content: [...content, { type: "text", text: nudge }] };
    }
  });
}
