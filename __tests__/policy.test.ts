import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpencodeAskBridge,
  createPolicyChecker,
  evaluateOperation,
  evaluatePermission,
  mergeDeep,
  readOpencodeRuleset,
  wildcardMatch,
  type OpencodeAsk,
  type PolicyRule,
} from "../policy.ts";
import { runPlanTree } from "../core/engine.ts";
import type { Operation, PlanTree } from "../core/types.ts";

// Every test gets its own config home, data home, home dir, and managed dir,
// so the developer's real opencode config never leaks in.
const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const setup = (extraEnv: Record<string, string> = {}) => {
  const tmp = mkdtempSync(join(tmpdir(), "px-policy-"));
  tmps.push(tmp);
  const project = join(tmp, "proj");
  const configHome = join(tmp, "config");
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(join(configHome, "opencode"), { recursive: true });
  const env = {
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: join(tmp, "data"),
    OPENCODE_TEST_HOME: join(tmp, "home"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(tmp, "managed"),
    ...extraEnv,
  } as NodeJS.ProcessEnv;
  const globalConfig = (config: unknown) =>
    writeFileSync(join(configHome, "opencode", "opencode.json"), JSON.stringify(config));
  const projectConfig = (config: unknown) => writeFileSync(join(project, "opencode.json"), JSON.stringify(config));
  return { tmp, project, env, configHome, globalConfig, projectConfig };
};

const verdict = (
  ctx: ReturnType<typeof setup>,
  operation: Operation,
  options: { agent?: string } = {},
): string => {
  const ruleset = readOpencodeRuleset(ctx.project, ctx.env, options);
  return evaluateOperation(operation, ruleset, { directory: ctx.project }).action;
};

describe("opencode 1.18.32 parity — flattened ruleset, wildcard keys, last match wins", () => {
  it.each<[Record<string, unknown>, Operation, string]>([
    [{ bash: "allow", "*": "deny" }, "ls", "deny"],
    [{ bash: { "git *": "allow" }, "*": "deny" }, "git status", "deny"],
    [{ "b*": "deny" }, "ls", "deny"],
    [{ bash: { "git log *": "deny" } }, "git log", "deny"],
    [{ read: { "~/secret/*": "deny" } }, { tool: "read", path: `${homedir()}/secret/a` }, "deny"],
  ])("opencode parity %#", (permission, operation, expected) => {
    const ctx = setup();
    ctx.projectConfig({ permission });
    expect(verdict(ctx, operation)).toBe(expected);
  });

  it("mergeDeep across global then project keeps first-appearance key order", () => {
    const ctx = setup();
    ctx.globalConfig({ permission: { bash: { "*": "allow", "cat *": "deny" } } });
    ctx.projectConfig({ permission: { bash: { "*": "allow" } } });
    expect(verdict(ctx, "cat secret.pem")).toBe("deny");
    expect(verdict(ctx, "ls")).toBe("allow");
  });

  it("a later layer overwrites a key's action in place", () => {
    const ctx = setup();
    ctx.globalConfig({ permission: { bash: { "git push *": "deny", "*": "allow" } } });
    ctx.projectConfig({ permission: { bash: { "git push *": "allow" } } });
    expect(verdict(ctx, "git push origin")).toBe("allow");
  });

  it("honors agent.<name>.permission for the session's agent only", () => {
    const ctx = setup();
    ctx.projectConfig({ agent: { review: { permission: { bash: { "git *": "deny" } } } } });
    expect(verdict(ctx, "git status", { agent: "review" })).toBe("deny");
    expect(verdict(ctx, "git status", { agent: "build" })).toBe("allow");
    expect(verdict(ctx, "git status")).toBe("allow");
  });

  it("honors mode.<name> as an agent, and default_agent when no agent is named", () => {
    const ctx = setup();
    ctx.projectConfig({ default_agent: "strict", mode: { strict: { permission: "deny" } } });
    expect(verdict(ctx, "ls")).toBe("deny");
  });

  it("honors OPENCODE_CONFIG_CONTENT after project configs", () => {
    const ctx = setup({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: { "ls *": "deny" } } }) });
    ctx.projectConfig({ permission: { bash: { "ls *": "allow" } } });
    expect(verdict(ctx, "ls -la")).toBe("deny");
  });

  it("OPENCODE_DISABLE_PROJECT_CONFIG skips project files and project .opencode dirs", () => {
    const ctx = setup({ OPENCODE_DISABLE_PROJECT_CONFIG: "1" });
    ctx.projectConfig({ permission: { bash: "deny" } });
    mkdirSync(join(ctx.project, ".opencode"));
    writeFileSync(join(ctx.project, ".opencode", "opencode.json"), JSON.stringify({ permission: "deny" }));
    expect(verdict(ctx, "ls")).toBe("allow");
    ctx.globalConfig({ permission: { bash: "deny" } });
    expect(verdict(ctx, "ls")).toBe("deny");
  });

  it("built-in external_directory ask for paths outside the project", () => {
    const ctx = setup();
    writeFileSync(join(ctx.project, "README.md"), "x");
    expect(verdict(ctx, "cat ~/.ssh/id_rsa")).toBe("ask");
    expect(verdict(ctx, "cat /etc/hosts")).toBe("ask");
    expect(verdict(ctx, { tool: "read", path: "/etc/hosts" })).toBe("ask");
    expect(verdict(ctx, { tool: "grep", pattern: "x", path: "/etc" })).toBe("ask");
    expect(verdict(ctx, { tool: "find", pattern: "*", path: "/etc" })).toBe("ask");
    expect(verdict(ctx, "cat README.md")).toBe("allow");
    expect(verdict(ctx, { tool: "read", path: "README.md" })).toBe("allow");
    // Non-file commands are not path-checked by opencode's shell tool.
    expect(verdict(ctx, "echo /etc/hosts")).toBe("allow");
  });

  it("external_directory rules are user-configurable, with ~ expansion", () => {
    const ctx = setup();
    ctx.projectConfig({ permission: { external_directory: { "~/.ssh/*": "deny", "/etc/*": "allow" } } });
    expect(verdict(ctx, "cat ~/.ssh/id_rsa")).toBe("deny");
    expect(verdict(ctx, "cat /etc/hosts")).toBe("allow");
  });

  it("built-in read defaults ask for .env files but allow .env.example", () => {
    const ctx = setup();
    expect(verdict(ctx, { tool: "read", path: ".env" })).toBe("ask");
    expect(verdict(ctx, { tool: "read", path: "config/.env.local" })).toBe("ask");
    expect(verdict(ctx, { tool: "read", path: ".env.example" })).toBe("allow");
  });

  it("extra path spellings only ever add a deny, never an ask", () => {
    const ctx = setup();
    ctx.projectConfig({ permission: { read: { "*": "ask", "src/*": "allow" } } });
    expect(verdict(ctx, { tool: "read", path: "src/a.ts" })).toBe("allow");
    ctx.projectConfig({ permission: { read: { [`${ctx.project}/src/*`]: "deny" } } });
    expect(verdict(ctx, { tool: "read", path: "src/a.ts" })).toBe("deny");
  });

  it("the explore agent's built-in overrides apply", () => {
    const ctx = setup();
    expect(verdict(ctx, "ls", { agent: "explore" })).toBe("allow");
    expect(verdict(ctx, { tool: "read", path: "/etc/hosts" }, { agent: "explore" })).toBe("ask");
  });

  it("reads config.json, opencode.json, opencode.jsonc from the global dir in that order", () => {
    const ctx = setup();
    writeFileSync(join(ctx.configHome, "opencode", "config.json"), JSON.stringify({ permission: { bash: { "ls *": "deny" } } }));
    writeFileSync(join(ctx.configHome, "opencode", "opencode.jsonc"), '{ // c\n "permission": {"bash": {"ls *": "allow"}} }');
    expect(verdict(ctx, "ls")).toBe("allow");
  });

  it("OPENCODE_CONFIG lands between global and project", () => {
    const ctx = setup();
    const custom = join(ctx.tmp, "custom.json");
    writeFileSync(custom, JSON.stringify({ permission: { bash: { "ls *": "deny" } } }));
    ctx.env.OPENCODE_CONFIG = custom;
    ctx.globalConfig({ permission: { bash: { "ls *": "allow" } } });
    expect(verdict(ctx, "ls")).toBe("deny");
    ctx.projectConfig({ permission: { bash: { "ls *": "allow" } } });
    expect(verdict(ctx, "ls")).toBe("allow");
  });

  it("project files merge farthest first, then .opencode dirs, then OPENCODE_CONFIG_DIR, then managed", () => {
    const ctx = setup();
    const sub = join(ctx.project, "sub");
    mkdirSync(sub);
    ctx.projectConfig({ permission: { bash: { "ls *": "deny" } } });
    writeFileSync(join(sub, "opencode.json"), JSON.stringify({ permission: { bash: { "ls *": "allow" } } }));
    const fromSub = () => evaluateOperation("ls", readOpencodeRuleset(sub, ctx.env), { directory: sub }).action;
    expect(fromSub()).toBe("allow");
    mkdirSync(join(ctx.project, ".opencode"));
    writeFileSync(join(ctx.project, ".opencode", "opencode.json"), JSON.stringify({ permission: { bash: { "ls *": "deny" } } }));
    expect(fromSub()).toBe("deny");
    const configDir = join(ctx.tmp, "cfgdir");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ permission: { bash: { "ls *": "allow" } } }));
    ctx.env.OPENCODE_CONFIG_DIR = configDir;
    expect(fromSub()).toBe("allow");
    mkdirSync(ctx.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!);
    writeFileSync(join(ctx.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!, "opencode.json"), JSON.stringify({ permission: { bash: { "ls *": "deny" } } }));
    expect(fromSub()).toBe("deny");
  });

  it("reads ~/.opencode/opencode.json", () => {
    const ctx = setup();
    mkdirSync(join(ctx.env.OPENCODE_TEST_HOME!, ".opencode"), { recursive: true });
    writeFileSync(join(ctx.env.OPENCODE_TEST_HOME!, ".opencode", "opencode.json"), JSON.stringify({ permission: { bash: "deny" } }));
    expect(verdict(ctx, "ls")).toBe("deny");
  });

  it("legacy tools:{x:false} and OPENCODE_PERMISSION feed the ruleset", () => {
    const ctx = setup();
    ctx.projectConfig({ tools: { bash: false } });
    expect(verdict(ctx, "ls")).toBe("deny");
    ctx.projectConfig({});
    ctx.env.OPENCODE_PERMISSION = JSON.stringify({ bash: { "ls *": "deny" } });
    expect(verdict(ctx, "ls")).toBe("deny");
  });

  it("a bare string permission applies to every key", () => {
    const ctx = setup();
    ctx.projectConfig({ permission: "deny" });
    expect(verdict(ctx, "ls")).toBe("deny");
    expect(verdict(ctx, { tool: "read", path: "README.md" })).toBe("deny");
  });

  it("maps native ops to opencode's permission keys", () => {
    const ctx = setup();
    ctx.projectConfig({ permission: { grep: { "TODO*": "deny" }, glob: { "*.pem": "deny" }, list: { "private*": "deny" } } });
    expect(verdict(ctx, { tool: "grep", pattern: "TODO:" })).toBe("deny");
    expect(verdict(ctx, { tool: "grep", pattern: "FIXME" })).toBe("allow");
    expect(verdict(ctx, { tool: "find", pattern: "*.pem" })).toBe("deny");
    expect(verdict(ctx, { tool: "ls", path: "private" })).toBe("deny");
    expect(verdict(ctx, { tool: "find", path: "private", pattern: "*.ts" })).toBe("deny");
  });
});

describe("readOpencodeRuleset — fail closed", () => {
  it("a config that exists but does not parse is an error, and the checker stops everything", () => {
    const ctx = setup();
    writeFileSync(join(ctx.project, "opencode.json"), "{ this is not json");
    const ruleset = readOpencodeRuleset(ctx.project, ctx.env);
    expect(ruleset).toEqual({ error: expect.stringContaining("opencode.json") });
    const check = createPolicyChecker(ruleset, { directory: ctx.project });
    expect(check("echo hi")).toContain("cannot read your opencode permission rules");
    expect(check({ tool: "read", path: "a" })).toContain("cannot read");
  });

  it("an action opencode's schema rejects is an error, not an ignored rule", () => {
    const ctx = setup();
    ctx.projectConfig({ permission: { bash: { "rm *": "maybe" } } });
    expect(readOpencodeRuleset(ctx.project, ctx.env)).toHaveProperty("error");
  });

  it("invalid OPENCODE_PERMISSION or OPENCODE_CONFIG_CONTENT fails closed", () => {
    expect(readOpencodeRuleset(setup().project, { ...setup().env, OPENCODE_PERMISSION: "{nope" })).toHaveProperty("error");
    const ctx = setup({ OPENCODE_CONFIG_CONTENT: "{nope" });
    expect(readOpencodeRuleset(ctx.project, ctx.env)).toHaveProperty("error");
  });

  it("reads .jsonc and treats an empty file as empty config", () => {
    const ctx = setup();
    writeFileSync(join(ctx.project, "opencode.jsonc"), '{\n  // no pushing\n  "permission": {"bash": {"git push *": "deny"}}\n}');
    writeFileSync(join(ctx.project, "opencode.json"), "");
    expect(verdict(ctx, "git push origin")).toBe("deny");
  });

  it("no config anywhere => built-in defaults allow ordinary project commands", () => {
    const ctx = setup();
    expect(verdict(ctx, "rm -rf build")).toBe("allow");
  });
});

describe("wildcard / evaluate / mergeDeep primitives", () => {
  it("trailing ' *' is optional; '*' and '?' span any character", () => {
    expect(wildcardMatch("git log", "git log *")).toBe(true);
    expect(wildcardMatch("git log --oneline", "git log *")).toBe(true);
    expect(wildcardMatch("git logs", "git log *")).toBe(false);
    expect(wildcardMatch("rm -rf tmp", "rm -r? *")).toBe(true);
    expect(wildcardMatch("a/b/c", "a/*")).toBe(true);
    expect(wildcardMatch("a.b", "a?b")).toBe(true);
    expect(wildcardMatch("axb", "a.b")).toBe(false);
  });

  it("evaluate: last rule matching key AND pattern wins; none matching is ask", () => {
    const rules: PolicyRule[] = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "deny" },
      { permission: "b*", pattern: "rm -i *", action: "allow" },
    ];
    expect(evaluatePermission("bash", "rm -i x", rules).action).toBe("allow");
    expect(evaluatePermission("bash", "rm x", rules).action).toBe("deny");
    expect(evaluatePermission("read", "rm x", rules).action).toBe("allow");
    expect(evaluatePermission("bash", "ls", []).action).toBe("ask");
  });

  it("mergeDeep keeps first-appearance key order and recurses into objects only", () => {
    const merged = mergeDeep({ a: { x: 1, y: 2 }, b: [1] }, { c: 3, a: { y: 9, z: 4 }, b: [2] });
    expect(Object.keys(merged)).toEqual(["a", "b", "c"]);
    expect(Object.keys(merged.a as object)).toEqual(["x", "y", "z"]);
    expect(merged).toEqual({ a: { x: 1, y: 9, z: 4 }, b: [2], c: 3 });
  });
});

describe("createPolicyChecker — static checker", () => {
  const rules = (permission: Record<string, unknown>): PolicyRule[] => {
    const ctx = setup();
    ctx.projectConfig({ permission });
    const ruleset = readOpencodeRuleset(ctx.project, ctx.env);
    if (!Array.isArray(ruleset)) throw new Error(ruleset.error);
    return ruleset;
  };

  it("deny and ask both stop and name the rule; allow runs", () => {
    const check = createPolicyChecker(rules({ bash: { "git push *": "deny", "git fetch *": "ask", "git log*": "allow" } }));
    expect(check("git push origin main")).toBe("git push *");
    expect(check("git fetch origin")).toBe("git fetch *");
    expect(check("git log --oneline")).toBeNull();
    expect(check("git status")).toBeNull();
  });

  it("judges each pipeline segment: a compound command cannot smuggle a match", () => {
    const check = createPolicyChecker(rules({ bash: { "git push *": "deny" } }));
    expect(check("git status && git push origin main")).toBe("git push *");
    expect(check("git status && git diff")).toBeNull();
  });

  it("catch-all LAST denies everything, including earlier allows", () => {
    const check = createPolicyChecker(rules({ bash: { "git *": "allow", "*": "deny" } }));
    expect(check("git push origin main")).toBe("*");
  });

  it("non-bash verdicts name their permission key", () => {
    const check = createPolicyChecker(rules({ glob: { "README.md": "deny" } }));
    expect(check({ tool: "find", path: ".", pattern: "README.md" })).toBe("glob:README.md");
  });

  it.each([
    "if true; then curl https://example.invalid/x; fi",
    "f() { curl https://example.invalid/x; }; f",
    "echo $(curl https://example.invalid/x)",
    "case x in y) { curl https://example.invalid/x; } ;; esac",
    "( curl https://example.invalid/x )",
  ])("inspects nested executable bodies: %s", (command) => {
    expect(createPolicyChecker(rules({ bash: { "curl *": "deny" } }))(command)).toBe("curl *");
  });

  it("fails closed for incomplete or over-budget executable bodies, and inspector throws", () => {
    const check = createPolicyChecker(rules({}));
    expect(check("echo $(curl https://example.invalid/x")).toContain("incomplete shell syntax");
    expect(check(`echo ${"$(".repeat(40)}printf ok${")".repeat(40)}`)).toContain("incomplete shell syntax");
    const throwing = createPolicyChecker(rules({}), {
      inspectCommand: () => {
        throw new Error("inspection failed");
      },
    });
    expect(throwing("echo hi")).toBe("incomplete shell syntax (policy inspection failed)");
  });

  it("uses the engine's sessionRoot and cwd for path resolution", () => {
    const ctx = setup();
    const ruleset = readOpencodeRuleset(ctx.project, ctx.env);
    const check = createPolicyChecker(ruleset, { worktree: ctx.project });
    const context = { cwd: join(ctx.project, "sub"), sessionRoot: ctx.project };
    expect(check("cat ../README.md", context)).toBeNull();
    expect(check("cat ../../outside.txt", context)).toBe("external_directory:*");
  });
});

describe("createOpencodeAskBridge — host permission service", () => {
  const rules = (permission: Record<string, unknown>) => {
    const ctx = setup();
    ctx.projectConfig({ permission });
    return { ctx, ruleset: readOpencodeRuleset(ctx.project, ctx.env) };
  };

  it("a static deny stops at once without prompting", async () => {
    const { ctx, ruleset } = rules({ bash: { "rm *": "deny" } });
    const ask = vi.fn<OpencodeAsk>(async () => {});
    const check = createOpencodeAskBridge(ask, ruleset, { directory: ctx.project });
    expect(await check("rm -rf x")).toBe("rm *");
    expect(ask).not.toHaveBeenCalled();
  });

  it("an unreadable policy stops without prompting", async () => {
    const ask = vi.fn<OpencodeAsk>(async () => {});
    const check = createOpencodeAskBridge(ask, { error: "x is broken" }, { directory: process.cwd() });
    expect(await check("ls")).toContain("cannot read your opencode permission rules");
    expect(ask).not.toHaveBeenCalled();
  });

  it("static ask and allow both defer to context.ask; resolution runs", async () => {
    const { ctx, ruleset } = rules({ bash: { "git fetch *": "ask" } });
    const ask = vi.fn<OpencodeAsk>(async () => {});
    const check = createOpencodeAskBridge(ask, ruleset, { directory: ctx.project });
    expect(await check("git fetch origin")).toBeNull();
    expect(await check("git status")).toBeNull();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[0]![0]).toEqual({
      permission: "bash",
      patterns: ["git fetch origin"],
      always: [],
      metadata: { source: "predexec", operation: "git fetch origin" },
    });
  });

  it("a rejection is a policyStop naming opencode's reason, and nothing more is asked", async () => {
    const { ctx, ruleset } = rules({});
    const ask = vi.fn<OpencodeAsk>(async () => {
      throw new Error("The user rejected permission to use this specific tool call.");
    });
    const check = createOpencodeAskBridge(ask, ruleset, { directory: ctx.project });
    expect(await check("git fetch origin")).toEqual({
      hostDenied: "opencode denied permission: The user rejected permission to use this specific tool call.",
    });
    // After a stop the walk is static-only: the default-allowed `git status`
    // is not prompted for.
    expect(await check("git status")).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("dedupes identical requests within one walk", async () => {
    const { ctx, ruleset } = rules({});
    const ask = vi.fn<OpencodeAsk>(async () => {});
    const check = createOpencodeAskBridge(ask, ruleset, { directory: ctx.project });
    await check("git status");
    await check("git status");
    await check("git status && git diff");
    expect(ask.mock.calls.map((c) => c[0].patterns)).toEqual([["git status"], ["git diff"]]);
  });

  it("asks external_directory before bash, as opencode's shell tool does", async () => {
    const { ctx, ruleset } = rules({});
    const ask = vi.fn<OpencodeAsk>(async () => {});
    const check = createOpencodeAskBridge(ask, ruleset, { directory: ctx.project });
    await check("cat /etc/hosts");
    expect(ask.mock.calls.map((c) => c[0].permission)).toEqual(["external_directory", "bash"]);
    expect(ask.mock.calls[0]![0].patterns).toEqual(["/etc/*"]);
  });

  it("asks read with the worktree-relative path for native reads", async () => {
    const { ctx, ruleset } = rules({});
    const ask = vi.fn<OpencodeAsk>(async () => {});
    const check = createOpencodeAskBridge(ask, ruleset, { directory: ctx.project, worktree: ctx.project });
    await check({ tool: "read", path: "src/a.ts" });
    expect(ask.mock.calls[0]![0].permission).toBe("read");
    // Only opencode's own spelling reaches the host — the extra deny-only
    // spellings must never add a prompt.
    expect(ask.mock.calls[0]![0].patterns).toEqual(["src/a.ts"]);
  });

  it("an aborted signal stops asking", async () => {
    const { ctx, ruleset } = rules({});
    const ask = vi.fn<OpencodeAsk>(async () => {});
    const controller = new AbortController();
    controller.abort();
    const check = createOpencodeAskBridge(ask, ruleset, { directory: ctx.project, signal: controller.signal });
    expect(await check("ls")).toContain("aborted");
    expect(ask).not.toHaveBeenCalled();
  });

  it("through the engine: a repeated operation is asked once", async () => {
    const { ctx, ruleset } = rules({});
    const ask = vi.fn<OpencodeAsk>(async () => {});
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo hi", "echo hi"] }] };
    const r = await runPlanTree(plan, {
      cwd: ctx.project,
      checkOperationPolicy: createOpencodeAskBridge(ask, ruleset, { directory: ctx.project }),
    });
    expect(r.stoppedReason).toBe("leaf");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  const walk = async (ctx: ReturnType<typeof setup>, ruleset: ReturnType<typeof readOpencodeRuleset>, commands: string[], ask: OpencodeAsk, signal?: AbortSignal) =>
    runPlanTree({ root: "a", nodes: [{ id: "a", commands }] }, {
      cwd: ctx.project,
      ...(signal ? { signal } : {}),
      checkOperationPolicy: createOpencodeAskBridge(ask, ruleset, { directory: ctx.project, worktree: ctx.project }),
    });

  it.each(["sh -c 'cat x'", "/usr/bin/env cat x", "'/bin/cat' x"])(
    "through the engine: variant spellings of %s cost exactly one host prompt",
    async (command) => {
      const { ctx, ruleset } = rules({ bash: { "*": "ask" } });
      writeFileSync(join(ctx.project, "x"), "x");
      const ask = vi.fn<OpencodeAsk>(async () => {});
      const r = await walk(ctx, ruleset, [command], ask);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask.mock.calls[0]![0].patterns).toEqual([command]);
      expect(r.stoppedReason).toBe("leaf");
    },
  );

  it("through the engine: a variant stricter than its primary still reaches the host", async () => {
    // `/bin/cat x` is allowed statically; its decoded `cat x` hits `cat *: ask`.
    const { ctx, ruleset } = rules({ bash: { "cat *": "ask" } });
    const ask = vi.fn<OpencodeAsk>(async () => {});
    await walk(ctx, ruleset, ["/bin/cat x"], ask);
    expect(ask.mock.calls.map((c) => c[0].patterns)).toEqual([["/bin/cat x"], ["cat x"]]);
  });

  it("through the engine: a variant's static deny stops without another prompt", async () => {
    const { ctx, ruleset } = rules({ bash: { "cat *": "deny" } });
    const ask = vi.fn<OpencodeAsk>(async () => {});
    const r = await walk(ctx, ruleset, ["/bin/cat x"], ask);
    expect(r.stoppedReason).toBe("policyStop");
    expect(r.transcript).toContain("host permission rule 'cat *'");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("through the engine: once a node is stopped, later operations are never prompted for", async () => {
    const { ctx, ruleset } = rules({ bash: { "*": "ask", "cat *": "deny" } });
    const ask = vi.fn<OpencodeAsk>(async () => {});
    const r = await walk(ctx, ruleset, ["cat x", "ls"], ask);
    expect(r.stoppedReason).toBe("policyStop");
    expect(ask).not.toHaveBeenCalled();
  });

  it("through the engine: an abort while a prompt is pending stops without running", async () => {
    const { ctx, ruleset } = rules({});
    const controller = new AbortController();
    const ask = vi.fn<OpencodeAsk>(() => {
      queueMicrotask(() => controller.abort());
      return new Promise<void>(() => {});
    });
    const r = await walk(ctx, ruleset, ["echo SHOULD_NOT_RUN"], ask, controller.signal);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(r.stoppedReason).toBe("aborted");
    expect(r.pathTaken).toEqual([]);
    expect(r.transcript).not.toContain("node a (exit");
  });

  it("through the engine: a rejection hard-stops before running", async () => {
    const { ctx, ruleset } = rules({});
    const ask: OpencodeAsk = async () => {
      throw new Error("nope");
    };
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo SHOULD_NOT_RUN"] }] };
    const r = await runPlanTree(plan, {
      cwd: ctx.project,
      checkOperationPolicy: createOpencodeAskBridge(ask, ruleset, { directory: ctx.project }),
    });
    expect(r.stoppedReason).toBe("policyStop");
    // A live host rejection reads as the host's answer, not as a static rule.
    expect(r.transcript).toContain("opencode denied permission: nope");
    expect(r.transcript).not.toContain("host permission rule");
    expect(r.transcript).not.toContain("node a (exit");
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
      checkOperationPolicy: (operation) => typeof operation === "string" && operation.startsWith("echo") ? "echo *" : null,
    });
    expect(r.stoppedReason).toBe("policyStop");
    expect(r.fellBack).toBe(true);
    expect(r.pathTaken).toEqual([]); // never ran
    expect(r.transcript).toContain("POLICY HARD-STOP (not run)");
    expect(r.transcript).toContain("host permission rule 'echo *'");
    expect(r.transcript).not.toContain("node a (exit");
  });

  it("checks {tool:'bash'} and native operations through one policy seam", async () => {
    const bashPlan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: [{ tool: "bash", command: "cat .env" }] }],
    };
    const seen: string[] = [];
    const check = (operation: Operation) => {
      const cmd = typeof operation === "string" ? operation : operation.command;
      seen.push(cmd);
      return cmd?.includes(".env") ? "cat *" : null;
    };
    const r = await runPlanTree(bashPlan, { cwd, checkOperationPolicy: check });
    expect(r.stoppedReason).toBe("policyStop");
    expect(seen).toEqual(["cat .env"]);

    const toolPlan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: [{ tool: "ls", path: "." }] }],
    };
    const r2 = await runPlanTree(toolPlan, {
      cwd,
      checkOperationPolicy: () => "*",
      executeToolOp: async () => ({ stdout: "f", stderr: "", exitCode: 0 }),
    });
    expect(r2.stoppedReason).toBe("policyStop");
  });

  it("no policy callback => unchanged behavior", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("leaf");
  });
});
