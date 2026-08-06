import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkNodeVersion,
  checkClaudeCode,
  checkOpencode,
  checkPi,
  findOpencodeConfigs,
  isDirectInvocation,
  onPath,
  parseStatsLines,
  piPackageSource,
  stripJsonComments,
  summarizeStats,
} from "../bin/predexec.mjs";

let tmp: string;
const scratch = () => (tmp = mkdtempSync(join(tmpdir(), "px-doctor-")));
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

const write = (rel: string, content: string) => {
  const path = join(tmp, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

describe("doctor — node version", () => {
  it("passes on >=22, fails below", () => {
    expect(checkNodeVersion("22.1.0").status).toBe("ok");
    expect(checkNodeVersion("18.19.0").status).toBe("fail");
  });
});

describe("doctor — pi checks", () => {
  const piOpts = (over: Record<string, unknown> = {}) => ({
    piAgentDir: join(tmp, "agent"),
    cwd: join(tmp, "proj"),
    installed: false,
    ...over,
  });

  it("skips when pi is neither configured nor on PATH", () => {
    scratch();
    expect(checkPi(piOpts())[0]!.status).toBe("skip");
  });

  it("reports info (not fail) when pi is installed but predexec is not registered", () => {
    scratch();
    const checks = checkPi(piOpts({ installed: true }));
    expect(checks[0]!.status).toBe("info");
    expect(checks.some((c) => c.status === "fail")).toBe(false);
  });

  it("reports info when pi is configured without a predexec entry", () => {
    scratch();
    write("agent/settings.json", JSON.stringify({ packages: ["npm:something-else"] }));
    const checks = checkPi(piOpts());
    expect(checks[0]!.status).toBe("info");
    expect(checks.some((c) => c.status === "fail")).toBe(false);
  });

  it("passes with settings entry + installed package + zod", () => {
    scratch();
    write("agent/settings.json", JSON.stringify({ packages: ["npm:predexec"] }));
    write("agent/npm/node_modules/predexec/package.json", JSON.stringify({ version: "0.1.3" }));
    write("agent/npm/node_modules/zod/package.json", JSON.stringify({ version: "4.1.8" }));
    const checks = checkPi(piOpts());
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    expect(checks.map((c) => c.name).join()).toContain("predexec@0.1.3");
  });

  it("recognizes the documented object form of a packages entry", () => {
    expect(piPackageSource("npm:predexec")).toBe("npm:predexec");
    expect(piPackageSource({ source: "npm:predexec", skills: [] })).toBe("npm:predexec");
    expect(piPackageSource({ nope: 1 })).toBeNull();

    scratch();
    write("agent/settings.json", JSON.stringify({ packages: [{ source: "npm:predexec" }] }));
    write("agent/npm/node_modules/predexec/package.json", JSON.stringify({ version: "0.1.3" }));
    write("agent/npm/node_modules/zod/package.json", JSON.stringify({ version: "4.1.8" }));
    expect(checkPi(piOpts()).every((c) => c.status === "ok")).toBe(true);
  });

  it("finds a project-scope install under .pi/", () => {
    scratch();
    write("proj/.pi/settings.json", JSON.stringify({ packages: ["npm:predexec"] }));
    write("proj/.pi/npm/node_modules/predexec/package.json", JSON.stringify({ version: "0.1.3" }));
    write("proj/.pi/npm/node_modules/zod/package.json", JSON.stringify({ version: "4.1.8" }));
    const checks = checkPi(piOpts());
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    expect(checks.map((c) => c.name).join()).toContain("(project)");
  });

  it("fails when a registered predexec is actually broken", () => {
    scratch();
    write("agent/settings.json", JSON.stringify({ packages: ["npm:predexec"] }));
    const statuses = checkPi(piOpts()).map((c) => c.status);
    expect(statuses).toContain("fail"); // declared but not installed
  });
});

describe("doctor — opencode checks", () => {
  const GOOD_PLUGIN = "export const server = 1;\nexport default { id: 'predexec', server };\n";
  const OLD_PLUGIN = "export const server = 1;\n"; // pre-0.1.1: named export only

  const setupCache = (pluginSrc: string, withZod: boolean) => {
    write(
      "cache/predexec@latest/node_modules/predexec/package.json",
      JSON.stringify({ version: "0.1.3" }),
    );
    write("cache/predexec@latest/node_modules/predexec/.opencode/plugins/predexec.ts", pluginSrc);
    if (withZod) {
      write("cache/predexec@latest/node_modules/zod/package.json", JSON.stringify({ version: "4.1.8" }));
    }
  };

  const ocOpts = (over: Record<string, unknown> = {}) => ({
    cwd: join(tmp, "proj"),
    home: join(tmp, "home"),
    cacheRoot: join(tmp, "cache"),
    installed: false,
    ...over,
  });

  it("skips when opencode is neither configured nor on PATH", () => {
    scratch();
    expect(checkOpencode(ocOpts())[0]!.status).toBe("skip");
  });

  it("reports info (not fail) when opencode is installed but unwired", () => {
    scratch();
    const checks = checkOpencode(ocOpts({ installed: true }));
    expect(checks[0]!.status).toBe("info");
  });

  it("collects every merged config, not just the first match", () => {
    scratch();
    write("proj/opencode.json", JSON.stringify({ plugin: [] }));
    write("home/.config/opencode/opencode.json", JSON.stringify({ plugin: ["predexec"] }));
    const found = findOpencodeConfigs(join(tmp, "proj"), join(tmp, "home"));
    expect(found.map((f) => f.path)).toEqual([
      join(tmp, "proj", "opencode.json"),
      join(tmp, "home", ".config", "opencode", "opencode.json"),
    ]);
  });

  it("honours a global plugin entry even when a project config exists without it", () => {
    scratch();
    // Regression: first-match-wins used to stop at the project config and
    // report a false failure for a perfectly good global install.
    write("proj/opencode.json", JSON.stringify({ plugin: [] }));
    write("home/.config/opencode/opencode.json", JSON.stringify({ plugin: ["predexec"] }));
    setupCache(GOOD_PLUGIN, true);
    const checks = checkOpencode(ocOpts());
    expect(checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("reads .jsonc configs without tripping on // inside string values", () => {
    expect(JSON.parse(stripJsonComments('{"$schema":"https://x.dev/c.json"}')).$schema).toBe("https://x.dev/c.json");
    expect(JSON.parse(stripJsonComments('{ // note\n "a": 1 /* b */ }')).a).toBe(1);

    scratch();
    write("home/.config/opencode/opencode.jsonc", '{\n  // plugins\n  "plugin": ["predexec"]\n}');
    setupCache(GOOD_PLUGIN, true);
    expect(checkOpencode(ocOpts()).every((c) => c.status === "ok")).toBe(true);
  });

  it("all green with entry + cached install + zod + default export", () => {
    scratch();
    write("home/.config/opencode/opencode.json", JSON.stringify({ plugin: ["predexec"] }));
    setupCache(GOOD_PLUGIN, true);
    expect(checkOpencode(ocOpts()).every((c) => c.status === "ok")).toBe(true);
  });

  it("flags a pre-0.1.1 cached plugin (no default export) and missing zod", () => {
    scratch();
    write("home/.config/opencode/opencode.json", JSON.stringify({ plugin: ["predexec"] }));
    setupCache(OLD_PLUGIN, false);
    const fails = checkOpencode(ocOpts())
      .filter((c) => c.status === "fail")
      .map((c) => c.name);
    expect(fails.join()).toContain("zod");
    expect(fails.join()).toContain("export shape");
  });

  it("labels a local plugin dir as a dev checkout, never as an install", () => {
    scratch();
    write("proj/opencode.json", JSON.stringify({ plugin: [] }));
    write("proj/.opencode/plugins/predexec.ts", GOOD_PLUGIN);
    const checks = checkOpencode(ocOpts());
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.name).toContain("dev checkout");
  });

  it("reports info, not fail, on a config without the plugin entry", () => {
    scratch();
    write("home/.config/opencode/opencode.json", JSON.stringify({ plugin: ["context-mode"] }));
    expect(checkOpencode(ocOpts())[0]!.status).toBe("info");
  });
});

describe("CLI entrypoint", () => {
  // Regression: the direct-invocation guard compared import.meta.url against a
  // hand-built `file://${argv[1]}`. npm installs bin entries as symlinks, so
  // that never matched and `npx predexec <anything>` printed nothing, exit 0.
  // Every other test imports the module, which bypasses the guard entirely —
  // so this one has to go through a real symlink and a real subprocess.
  const bin = fileURLToPath(new URL("../bin/predexec.mjs", import.meta.url));

  it("detects direct invocation through a symlink", () => {
    scratch();
    const link = join(tmp, "predexec-link");
    symlinkSync(bin, link);
    const moduleUrl = pathToFileURL(bin).href;
    expect(isDirectInvocation(moduleUrl, link)).toBe(true);
    expect(isDirectInvocation(moduleUrl, bin)).toBe(true);
    expect(isDirectInvocation(moduleUrl, join(tmp, "unrelated"))).toBe(false);
    expect(isDirectInvocation(moduleUrl, undefined)).toBe(false);
  });

  it("runs when spawned through a bin-style symlink", () => {
    scratch();
    const link = join(tmp, "predexec");
    symlinkSync(bin, link);
    const run = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints usage for --help (exit 0) and for a bad command (exit 1)", () => {
    const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("usage: predexec");

    const bad = spawnSync(process.execPath, [bin, "nonsense"], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("usage: predexec");
  });
});

describe("doctor — claude code checks", () => {
  const ccOpts = (over: Record<string, unknown> = {}) => ({
    cwd: join(tmp, "proj"),
    home: join(tmp, "home"),
    configDir: join(tmp, "home", ".claude"),
    installed: false,
    ...over,
  });

  it("skips when claude code is neither installed nor configured", () => {
    scratch();
    expect(checkClaudeCode(ccOpts())[0]!.status).toBe("skip");
  });

  it("reports info (not fail) when claude is installed but predexec is not registered", () => {
    scratch();
    const checks = checkClaudeCode(ccOpts({ installed: true }));
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.hint).toContain("claude mcp add");
  });

  it("finds a user-scope server in ~/.claude.json", () => {
    scratch();
    write("home/.claude.json", JSON.stringify({ mcpServers: { predexec: { command: "npx" } } }));
    const checks = checkClaudeCode(ccOpts());
    expect(checks[0]!.status).toBe("ok");
    expect(checks[0]!.name).toContain("(user)");
  });

  it("finds a project-scope server and flags it as awaiting approval", () => {
    scratch();
    // A project .mcp.json server is inert until approved once interactively —
    // actionable, but not a failure.
    write("proj/.mcp.json", JSON.stringify({ mcpServers: { predexec: { command: "npx" } } }));
    const checks = checkClaudeCode(ccOpts());
    expect(checks[0]!.status).toBe("ok");
    expect(checks.some((c) => c.status === "info" && /approval/.test(c.name))).toBe(true);
    expect(checks.some((c) => c.status === "fail")).toBe(false);
  });

  it("treats an approved project server as fully wired", () => {
    scratch();
    write("proj/.mcp.json", JSON.stringify({ mcpServers: { predexec: {} } }));
    write(
      "home/.claude.json",
      JSON.stringify({ projects: { [join(tmp, "proj")]: { enabledMcpjsonServers: ["predexec"] } } }),
    );
    expect(checkClaudeCode(ccOpts()).every((c) => c.status === "ok")).toBe(true);
  });
});

describe("doctor — PATH detection", () => {
  it("finds a binary on PATH and misses one that is absent", () => {
    scratch();
    mkdirSync(join(tmp, "bin"), { recursive: true });
    writeFileSync(join(tmp, "bin", "faketool"), "#!/bin/sh\n");
    expect(onPath("faketool", { PATH: join(tmp, "bin") })).toBe(true);
    expect(onPath("faketool", { PATH: join(tmp, "empty") })).toBe(false);
    expect(onPath("faketool", {})).toBe(false);
  });
});

describe("stats aggregation", () => {
  it("parses JSONL tolerantly and summarizes", () => {
    const lines = [
      JSON.stringify({ v: 1, harness: "pi", stoppedReason: "leaf", depthReached: 2, nodes: 3, ops: 5, edgesEvaluated: 3, edgesMatched: 2, requestsSaved: 4 }),
      "not json",
      JSON.stringify({ v: 1, harness: "opencode", stoppedReason: "noEdgeMatch", depthReached: 0, nodes: 1, ops: 2, edgesEvaluated: 1, edgesMatched: 0, requestsSaved: 1 }),
      JSON.stringify({ v: 99, harness: "future" }),
    ].join("\n");
    const records = parseStatsLines(lines);
    expect(records).toHaveLength(2);
    const s = summarizeStats(records);
    expect(s).toMatchObject({
      runs: 2,
      byHarness: { pi: 1, opencode: 1 },
      byStoppedReason: { leaf: 1, noEdgeMatch: 1 },
      ops: 7,
      requestsSaved: 5,
      edgesEvaluated: 4,
      edgesMatched: 2,
      avgDepth: 1,
    });
  });
});
