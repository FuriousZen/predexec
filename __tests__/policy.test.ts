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

  it("missing permission / junk actions => no rules", () => {
    expect(parseBashPermission("{}")).toEqual([]);
    expect(parseBashPermission('{"permission":{}}')).toEqual([]);
    expect(parseBashPermission('{"permission":{"bash":{"x":"maybe"}}}')).toEqual([]);
    expect(parseBashPermission('{"permission":{"bash":[1,2]}}')).toEqual([]);
  });

  it("throws on malformed json so the caller can fail closed", () => {
    // Previously swallowed to []. An existing-but-unparseable policy file then
    // read as "no rules" = allow everything, which is the worst possible guess.
    expect(() => parseBashPermission("{not json")).toThrow();
  });

  it("bare string shorthand applies to bash", () => {
    expect(parseBashPermission('{"permission":"deny"}')).toEqual([{ pattern: "*", action: "deny" }]);
    expect(parseBashPermission('{"permission":"allow"}')).toEqual([]);
  });

  it("falls back to the '*' tool key when there is no explicit bash key", () => {
    // `{"permission":{"*":"deny"}}` denies bash too; reading only `.bash` saw
    // nothing here and allowed everything.
    expect(parseBashPermission('{"permission":{"*":"deny"}}')).toEqual([{ pattern: "*", action: "deny" }]);
    // An explicit bash key still wins over the fallback.
    expect(parseBashPermission('{"permission":{"*":"deny","bash":"allow"}}')).toEqual([]);
  });

  it("preserves declaration order, which IS the precedence order", () => {
    expect(parseBashPermission('{"permission":{"bash":{"*":"deny","git *":"allow"}}}')).toEqual([
      { pattern: "*", action: "deny" },
      { pattern: "git *", action: "allow" },
    ]);
  });
});

describe("readOpencodeBashRules — global first, project last (last-wins)", () => {
  let tmp: string;
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  const setup = () => {
    tmp = mkdtempSync(join(tmpdir(), "px-policy-"));
    const project = join(tmp, "proj");
    const configHome = join(tmp, "config");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(configHome, "opencode"), { recursive: true });
    return { project, env: { XDG_CONFIG_HOME: configHome } as NodeJS.ProcessEnv, configHome };
  };

  it("orders global before project so the nearer config wins under last-wins", () => {
    const { project, env, configHome } = setup();
    writeFileSync(join(project, "opencode.json"), '{"permission":{"bash":{"cat *":"deny"}}}');
    writeFileSync(join(configHome, "opencode", "opencode.json"), '{"permission":{"bash":{"git push *":"ask"}}}');
    expect(readOpencodeBashRules(project, env).rules).toEqual([
      { pattern: "git push *", action: "ask" },
      { pattern: "cat *", action: "deny" },
    ]);
  });

  it("reads .jsonc — comments used to silently yield zero rules (= allow all)", () => {
    const { project, env } = setup();
    writeFileSync(
      join(project, "opencode.jsonc"),
      '{\n  // no pushing\n  "permission": {"bash": {"git push *": "deny"}}\n}',
    );
    expect(readOpencodeBashRules(project, env).rules).toEqual([{ pattern: "git push *", action: "deny" }]);
  });

  it("reports a config that exists but does not parse, so the caller can fail closed", () => {
    const { project, env } = setup();
    writeFileSync(join(project, "opencode.json"), "{ this is not json");
    const { rules, unreadable } = readOpencodeBashRules(project, env);
    expect(rules).toEqual([]);
    expect(unreadable).toHaveLength(1);
    expect(createPolicyChecker(rules, unreadable)("echo hi")).toContain("not valid JSON");
  });

  it("missing files => no rules, never throws", () => {
    tmp = mkdtempSync(join(tmpdir(), "px-policy-"));
    const out = readOpencodeBashRules(join(tmp, "nope"), { XDG_CONFIG_HOME: join(tmp, "noconf") } as NodeJS.ProcessEnv);
    expect(out.rules).toEqual([]);
    expect(out.unreadable).toEqual([]);
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

  it("LAST matching rule wins — the documented catch-all-first idiom", () => {
    // https://opencode.ai/docs/permissions/ — "Rules are evaluated by pattern
    // match, with the last matching rule winning."
    const check = createPolicyChecker([
      { pattern: "*", action: "ask" },
      { pattern: "git log*", action: "allow" },
    ]);
    expect(check("git log --oneline")).toBe(null);
    expect(check("cat .env")).toBe("*");
  });

  it("catch-all LAST denies everything, including earlier allows", () => {
    // Regression: longest-pattern-wins picked `git *` (longer) and returned
    // allow, so predexec ran a command opencode itself would have denied.
    const check = createPolicyChecker([
      { pattern: "git *", action: "allow" },
      { pattern: "*", action: "deny" },
    ]);
    expect(check("git push origin main")).toBe("*");
    expect(check("echo hi")).toBe("*");
  });

  it("supports ? as a single-character wildcard", () => {
    const check = createPolicyChecker([{ pattern: "rm -r? *", action: "deny" }]);
    expect(check("rm -rf tmp")).toBe("rm -r? *");
    expect(check("rm -r tmp")).toBe(null);
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
