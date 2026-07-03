import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPolicyChecker, parseBashPermission, readOpencodeBashRules } from "../policy.ts";
import { runPlanTree } from "../core/engine.ts";
import type { PlanTree } from "../core/types.ts";

describe("parseBashPermission — opencode config shapes", () => {
  it("string form: deny/ask become a global rule, allow becomes none", () => {
    expect(parseBashPermission('{"permission":{"bash":"deny"}}')).toEqual([{ pattern: "*", action: "deny" }]);
    expect(parseBashPermission('{"permission":{"bash":"ask"}}')).toEqual([{ pattern: "*", action: "ask" }]);
    expect(parseBashPermission('{"permission":{"bash":"allow"}}')).toEqual([]);
  });

  it("object form: one rule per pattern, allow entries kept for precedence", () => {
    const rules = parseBashPermission('{"permission":{"bash":{"git push *":"deny","git log*":"allow"}}}');
    expect(rules).toEqual([
      { pattern: "git push *", action: "deny" },
      { pattern: "git log*", action: "allow" },
    ]);
  });

  it("malformed json / missing permission / junk actions => no rules", () => {
    expect(parseBashPermission("{not json")).toEqual([]);
    expect(parseBashPermission("{}")).toEqual([]);
    expect(parseBashPermission('{"permission":{}}')).toEqual([]);
    expect(parseBashPermission('{"permission":{"bash":{"x":"maybe"}}}')).toEqual([]);
    expect(parseBashPermission('{"permission":{"bash":[1,2]}}')).toEqual([]);
  });
});

describe("readOpencodeBashRules — project + global, project first", () => {
  let tmp: string;
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  it("merges both files with project rules listed first", () => {
    tmp = mkdtempSync(join(tmpdir(), "px-policy-"));
    const project = join(tmp, "proj");
    const configHome = join(tmp, "config");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(configHome, "opencode"), { recursive: true });
    writeFileSync(join(project, "opencode.json"), '{"permission":{"bash":{"cat *":"deny"}}}');
    writeFileSync(
      join(configHome, "opencode", "opencode.json"),
      '{"permission":{"bash":{"git push *":"ask"}}}',
    );
    const rules = readOpencodeBashRules(project, { XDG_CONFIG_HOME: configHome } as NodeJS.ProcessEnv);
    expect(rules).toEqual([
      { pattern: "cat *", action: "deny" },
      { pattern: "git push *", action: "ask" },
    ]);
  });

  it("missing files => no rules, never throws", () => {
    tmp = mkdtempSync(join(tmpdir(), "px-policy-"));
    expect(readOpencodeBashRules(join(tmp, "nope"), { XDG_CONFIG_HOME: join(tmp, "noconf") } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("createPolicyChecker — matching & precedence", () => {
  it("deny and ask both stop; allow does not", () => {
    const check = createPolicyChecker([
      { pattern: "git push *", action: "deny" },
      { pattern: "git fetch *", action: "ask" },
      { pattern: "git log*", action: "allow" },
    ]);
    expect(check("git push origin main")).toBe("git push *");
    expect(check("git fetch origin")).toBe("git fetch *");
    expect(check("git log --oneline")).toBe(null);
    expect(check("git status")).toBe(null);
  });

  it("judges each pipeline segment: a compound command cannot smuggle a match", () => {
    const check = createPolicyChecker([{ pattern: "git push *", action: "deny" }]);
    expect(check("git status && git push origin main")).toBe("git push *");
    expect(check("git status && git diff")).toBe(null);
  });

  it("longest matching pattern wins: specific allow overrides broad ask", () => {
    const check = createPolicyChecker([
      { pattern: "*", action: "ask" },
      { pattern: "git log*", action: "allow" },
    ]);
    expect(check("git log --oneline")).toBe(null);
    expect(check("cat .env")).toBe("*");
  });

  it("global '*': 'ask' stops everything (predexec cannot prompt)", () => {
    const check = createPolicyChecker([{ pattern: "*", action: "ask" }]);
    expect(check("echo hi")).toBe("*");
  });

  it("no rules => cheap no-op", () => {
    expect(createPolicyChecker([])("rm -rf /")).toBe(null);
  });

  it("a broken pattern is skipped, not thrown", () => {
    const check = createPolicyChecker([{ pattern: "ok *", action: "deny" }]);
    expect(check("ok then")).toBe("ok *");
  });
});

describe("engine — policyStop", () => {
  const cwd = process.cwd();

  it("hard-stops BEFORE running a policy-matched command, with the rule in the transcript", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: ["echo SHOULD_NOT_RUN"] }],
    };
    const r = await runPlanTree(plan, {
      cwd,
      checkCommandPolicy: (cmd) => (cmd.startsWith("echo") ? "echo *" : null),
    });
    expect(r.stoppedReason).toBe("policyStop");
    expect(r.fellBack).toBe(true);
    expect(r.pathTaken).toEqual([]); // never ran
    expect(r.transcript).toContain("POLICY HARD-STOP (not run)");
    expect(r.transcript).toContain("host permission rule 'echo *'");
    expect(r.transcript).not.toContain("node a (exit");
  });

  it("checks {tool:'bash'} ops but not native read-only tool ops", async () => {
    const bashPlan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: [{ tool: "bash", command: "cat .env" }] }],
    };
    const seen: string[] = [];
    const check = (cmd: string) => (seen.push(cmd), cmd.includes(".env") ? "cat *" : null);
    const r = await runPlanTree(bashPlan, { cwd, checkCommandPolicy: check });
    expect(r.stoppedReason).toBe("policyStop");
    expect(seen).toEqual(["cat .env"]);

    const toolPlan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: [{ tool: "ls", path: "." }] }],
    };
    const r2 = await runPlanTree(toolPlan, {
      cwd,
      checkCommandPolicy: () => "*",
      executeToolOp: async () => ({ stdout: "f", stderr: "", exitCode: 0 }),
    });
    expect(r2.stoppedReason).toBe("leaf"); // tool ops are not shell commands
  });

  it("no policy callback => unchanged behavior", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("leaf");
  });
});
