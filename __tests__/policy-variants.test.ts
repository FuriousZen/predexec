// Policy variant expansion through the engine, against every real static
// checker: a shell wrapped inside a command substitution, and shell nesting
// past the expansion bound, must never let a denied inner command run.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPlanTree } from "../core/engine.ts";
import type { PlanTree, PolicyCheckContext, PolicyVerdict } from "../core/types.ts";
import type { Operation } from "../core/types.ts";
import { createClaudePolicyChecker, parseClaudeBashRules } from "../mcp/policy-claude.ts";
import { createCodexPolicyChecker } from "../mcp/policy-codex.ts";
import { createPolicyChecker } from "../policy.ts";

type Checker = (operation: Operation, context?: PolicyCheckContext) => PolicyVerdict | Promise<PolicyVerdict>;

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "px-policy-variants-"));
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const checkers: Array<[name: string, make: () => Checker]> = [
  ["Claude Bash(cat .env)", () => createClaudePolicyChecker(parseClaudeBashRules('{"permissions":{"deny":["Bash(cat .env)"]}}'))],
  ["Codex forbidden [cat, .env]", () => createCodexPolicyChecker([{ pattern: ["cat", ".env"], decision: "forbidden" }], [])],
  ["opencode v1 'cat .env': deny", () => createPolicyChecker([{ permission: "*", pattern: "*", action: "allow" }, { permission: "bash", pattern: "cat .env", action: "deny" }], { directory: repo, worktree: repo })],
];

const run = (command: string, check: Checker) =>
  runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] } as PlanTree, { cwd: repo, checkOperationPolicy: check });

/** `sh -c` wrapped around `cat .env` `levels` times, with correct quoting at every level. */
const nestShells = (levels: number): string => {
  let command = "cat .env";
  for (let i = 0; i < levels; i++) command = `sh -c '${command.replace(/'/g, `'\\''`)}'`;
  return command;
};

describe.each(checkers)("policy variants through the engine — %s", (_name, make) => {
  it.each([
    `echo "$(sh -c 'cat .env')"`,
    "echo `bash -c 'cat .env'`",
    `x=$(sh -c 'cat .env'); echo "$x"`,
    "echo $(bash -c \"sh -c 'cat .env'\")",
    "diff <(sh -c 'cat .env') /dev/null",
  ])("a shell inside a substitution is unwrapped: %s", async (command) => {
    const r = await run(command, make());
    expect(r.stoppedReason).toBe("policyStop");
    expect(r.pathTaken).toEqual([]);
    expect(r.transcript).not.toContain("SECRET=1");
  });

  it("the unwrapped control still runs when nothing is denied", async () => {
    const r = await run(`echo "$(sh -c 'echo ok')"`, make());
    expect(r.stoppedReason).toBe("leaf");
  });

  it("nesting within the bound is expanded and stopped", async () => {
    const r = await run(nestShells(3), make());
    expect(r.stoppedReason).toBe("policyStop");
  });
});
