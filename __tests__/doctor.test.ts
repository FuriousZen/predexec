import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentsFileHasRouting,
  ancestorsOf,
  antigravitySkillRoots,
  checkAntigravitySkill,
  checkClaudeCode,
  checkClaudeSkill,
  checkCodex,
  checkCodexSkill,
  checkNodeVersion,
  checkOpencode,
  checkOpencodeSkill,
  checkPi,
  claudeSkillRoots,
  codexSkillRoots,
  findOpencodeConfigs,
  findPredexecSkills,
  isDirectInvocation,
  onPath,
  opencodeSkillRoots,
  parseStatsLines,
  parseTomlLite,
  piPackageSource,
  projectDirsFromRootToCwd,
  readCanonicalSkillText,
  SKILL_SOURCE_PATHS,
  skillCheck,
  stripJsonComments,
  summarizeStats,
} from "../bin/predexec.mjs";
import { stripJsonComments as policyStripJsonComments } from "../policy.ts";
import { parseTomlLite as tsParseTomlLite } from "../mcp/toml-lite.ts";
import { TOML_LITE_FIXTURES } from "./helpers/toml-fixtures.ts";

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

  it("fails when a pi.extensions/skills manifest entry does not exist in the installed package", () => {
    scratch();
    write("agent/settings.json", JSON.stringify({ packages: ["npm:predexec"] }));
    write(
      "agent/npm/node_modules/predexec/package.json",
      JSON.stringify({
        version: "0.1.3",
        pi: { extensions: ["./dist/.pi/extension/index.js"], skills: ["./skills/predexec"] },
      }),
    );
    write("agent/npm/node_modules/zod/package.json", JSON.stringify({ version: "4.1.8" }));
    const checks = checkPi(piOpts());
    const fails = checks.filter((c) => c.status === "fail");
    expect(fails.some((c) => c.name.includes("./dist/.pi/extension/index.js"))).toBe(true);
    expect(fails.some((c) => c.name.includes("./skills/predexec"))).toBe(true);
    expect(fails[0]!.hint).toMatch(/reinstall|upgrade/);
  });

  it("passes when the declared pi manifest entries exist on disk", () => {
    scratch();
    write("agent/settings.json", JSON.stringify({ packages: ["npm:predexec"] }));
    write(
      "agent/npm/node_modules/predexec/package.json",
      JSON.stringify({ version: "0.1.3", pi: { extensions: ["./dist/.pi/extension/index.js"] } }),
    );
    write("agent/npm/node_modules/predexec/dist/.pi/extension/index.js", "export default {};");
    write("agent/npm/node_modules/zod/package.json", JSON.stringify({ version: "4.1.8" }));
    expect(checkPi(piOpts()).every((c) => c.status === "ok")).toBe(true);
  });

  it("finds zod nested under the predexec package, not only hoisted", () => {
    scratch();
    write("agent/settings.json", JSON.stringify({ packages: ["npm:predexec"] }));
    write("agent/npm/node_modules/predexec/package.json", JSON.stringify({ version: "0.1.3" }));
    write("agent/npm/node_modules/predexec/node_modules/zod/package.json", JSON.stringify({ version: "4.1.8" }));
    expect(checkPi(piOpts()).every((c) => c.status === "ok")).toBe(true);
  });
});

describe("doctor — opencode checks", () => {
  const GOOD_PLUGIN = "export const server = 1;\nexport default { id: 'predexec', server };\n";
  const OLD_PLUGIN = "export const server = 1;\n"; // pre-0.1.1: named export only

  const setupCache = (pluginSrc: string, withZod: boolean, main = "dist/.opencode/plugins/predexec.js") => {
    write(
      "cache/predexec@latest/node_modules/predexec/package.json",
      JSON.stringify({ version: "0.1.3", main }),
    );
    write(`cache/predexec@latest/node_modules/predexec/${main}`, pluginSrc);
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

  it("bin/predexec.mjs and policy.ts carry independent stripJsonComments implementations that must stay in parity", () => {
    const fixtures = [
      '{"$schema":"https://x.dev/c.json"}', // comment-marker-lookalike inside a string
      '{ // note\n "a": 1 /* b */ }', // line comment + block comment
      '{\n  // no pushing\n  "permission": {"bash": {"git push *": "deny"}}\n}', // line comment before real content
      '{\n  // plugins\n  "plugin": ["predexec"]\n}',
    ];
    for (const fixture of fixtures) {
      expect(stripJsonComments(fixture)).toBe(policyStripJsonComments(fixture));
    }
  });

  it("bin/predexec.mjs and mcp/toml-lite.ts carry independent parseTomlLite implementations that must stay in parity", () => {
    // Single source of truth with __tests__/mcp/toml-lite.test.ts's behavior
    // assertions (__tests__/helpers/toml-fixtures.ts) — the FULL fixture
    // table runs through both implementations here, including every
    // explicit-failure case, so a new fixture added for one test
    // automatically extends parity coverage instead of silently drifting.
    expect(TOML_LITE_FIXTURES.length).toBeGreaterThan(0);
    for (const { name, input } of TOML_LITE_FIXTURES) {
      expect(parseTomlLite(input), `fixture: ${name}`).toEqual(tsParseTomlLite(input));
    }
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

  it("diagnoses a CJS-compiled plugin distinctly from the generic pre-0.1.1 shape", () => {
    scratch();
    const CJS_PLUGIN = 'Object.defineProperty(exports, "__esModule", { value: true });\nexports.default = { id: "predexec", server: 1 };\n';
    write("home/.config/opencode/opencode.json", JSON.stringify({ plugin: ["predexec"] }));
    setupCache(CJS_PLUGIN, true);
    const fail = checkOpencode(ocOpts()).find((c) => c.name === "opencode cache: plugin export shape");
    expect(fail?.status).toBe("fail");
    expect(fail?.hint).toContain("CommonJS");
    expect(fail?.hint).not.toContain("clear the cache dir");
  });

  it("keeps the pre-0.1.1 'clear the cache' hint for a genuinely old named-export-only build", () => {
    scratch();
    write("home/.config/opencode/opencode.json", JSON.stringify({ plugin: ["predexec"] }));
    setupCache(OLD_PLUGIN, true);
    const fail = checkOpencode(ocOpts()).find((c) => c.name === "opencode cache: plugin export shape");
    expect(fail?.status).toBe("fail");
    expect(fail?.hint).toContain("clear the cache dir");
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

  it("recognizes a plugin-form install via installed_plugins.json when no mcp scope matches", () => {
    scratch();
    write(
      "home/.claude/plugins/installed_plugins.json",
      JSON.stringify({
        version: 2,
        plugins: {
          "predexec@some-marketplace": [
            { scope: "user", installPath: "/x/predexec/1.0.0", version: "1.0.0" },
          ],
        },
      }),
    );
    const checks = checkClaudeCode(ccOpts());
    expect(checks[0]!.status).toBe("ok");
    expect(checks[0]!.name).toContain("plugin installed");
    expect(checks.some((c) => c.status === "fail")).toBe(false);
  });

  it("mentions the plugin form as an alternative when nothing at all is registered", () => {
    scratch();
    const checks = checkClaudeCode(ccOpts({ installed: true }));
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.hint).toContain("plugin form");
  });

  it("finds a local-scope server registered from an ancestor directory (CC-6)", () => {
    scratch();
    const projectRoot = join(tmp, "proj");
    const subDir = join(projectRoot, "sub", "dir");
    mkdirSync(subDir, { recursive: true });
    write(
      "home/.claude.json",
      JSON.stringify({ projects: { [projectRoot]: { mcpServers: { predexec: { command: "npx" } } } } }),
    );
    const checks = checkClaudeCode(ccOpts({ cwd: subDir }));
    expect(checks[0]!.status).toBe("ok");
    expect(checks[0]!.name).toContain("(local)");
    expect(checks[0]!.detail).toContain(projectRoot);
  });

  it("does not match a local-scope registration from an unrelated sibling directory", () => {
    scratch();
    const sibling = join(tmp, "other-project");
    mkdirSync(join(tmp, "proj"), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    write("home/.claude.json", JSON.stringify({ projects: { [sibling]: { mcpServers: { predexec: {} } } } }));
    expect(checkClaudeCode(ccOpts({ installed: true }))[0]!.status).toBe("info");
  });
});

describe("ancestorsOf / projectDirsFromRootToCwd", () => {
  it("walks every ancestor up to the filesystem root, closest first", () => {
    const dirs = ancestorsOf(join("/a", "b", "c"));
    expect(dirs[0]).toBe(join("/a", "b", "c"));
    expect(dirs[dirs.length - 1]).toBe(join("/"));
  });

  it("layers from the nearest git root down to cwd", () => {
    scratch();
    const root = join(tmp, "repo");
    const sub = join(root, "sub", "dir");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(sub, { recursive: true });
    expect(projectDirsFromRootToCwd(sub)).toEqual([root, join(root, "sub"), sub]);
  });

  it("stops at the filesystem root when no .git is found", () => {
    scratch();
    const dir = join(tmp, "no-git-here");
    mkdirSync(dir, { recursive: true });
    const dirs = projectDirsFromRootToCwd(dir);
    expect(dirs[dirs.length - 1]).toBe(dir);
    expect(dirs[0]).toBe(join("/"));
  });
});

describe("doctor — codex checks", () => {
  const cxOpts = (over: Record<string, unknown> = {}) => ({
    codexHome: join(tmp, "codex-home"),
    installed: false,
    ...over,
  });

  const GOOD_ARGS = ["-y", "--package=predexec", "predexec-mcp", "--host", "codex"];

  const configToml = (server: Record<string, unknown>) => {
    const lines = ["[mcp_servers.predexec]"];
    for (const [k, v] of Object.entries(server)) {
      if (Array.isArray(v)) lines.push(`${k} = [${v.map((s) => JSON.stringify(s)).join(", ")}]`);
      else if (typeof v === "string") lines.push(`${k} = ${JSON.stringify(v)}`);
      else lines.push(`${k} = ${v}`);
    }
    return lines.join("\n") + "\n";
  };

  // A fake `codex` executable for the `codex mcp get --json` path, so the
  // json-preferred detection branch is exercised through a real spawnSync
  // call rather than only through the toml fallback. Scenario is selected via
  // an env var so one script fixture covers several registration shapes.
  const writeFakeCodex = () => {
    const path = join(tmp, "fake-codex.mjs");
    writeFileSync(
      path,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--version') { console.log('codex-cli 0.149.1'); process.exit(0); }",
        "if (args[0] === 'mcp' && args[1] === 'get' && args[2] === 'predexec' && args.includes('--json')) {",
        "  const scenario = process.env.FAKE_CODEX_SCENARIO || 'ok';",
        "  if (scenario === 'not-registered') process.exit(1);",
        "  const out = {",
        "    name: 'predexec', enabled: scenario !== 'disabled', disabled_reason: null,",
        "    transport: {",
        "      type: 'stdio', command: 'npx',",
        "      args: scenario === 'missing-host' ? ['-y', '--package=predexec', 'predexec-mcp'] : ['-y', '--package=predexec', 'predexec-mcp', '--host', 'codex'],",
        "      env: null, env_vars: [], cwd: null,",
        "    },",
        "  };",
        "  console.log(JSON.stringify(out));",
        "  process.exit(0);",
        "}",
        "process.exit(1);",
      ].join("\n"),
    );
    chmodSync(path, 0o755);
    return path;
  };

  it("reports absent when there is no ~/.codex dir and codex is not on PATH", () => {
    scratch();
    expect(checkCodex(cxOpts())[0]!.status).toBe("skip");
  });

  it("reports not-wired when codexHome exists but config.toml has no predexec entry", () => {
    scratch();
    write("codex-home/config.toml", '[mcp_servers.other]\ncommand = "foo"\n');
    const checks = checkCodex(cxOpts());
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.hint).toContain("codex mcp add predexec");
    expect(checks[0]!.hint).toContain("--host codex");
  });

  it("reports not-wired when codex is on PATH but no config.toml exists at all", () => {
    scratch();
    mkdirSync(join(tmp, "codex-home"), { recursive: true });
    const checks = checkCodex(cxOpts({ installed: true, codexBin: join(tmp, "nonexistent-codex") }));
    // installed via override, but the (nonexistent) binary can't be spawned —
    // detection must not throw, and must still land on not-wired since there
    // is no config.toml to fall back to either.
    expect(checks.some((c) => c.status === "info" && /not registered/.test(c.name))).toBe(true);
    expect(checks.every((c) => c.status !== "fail")).toBe(true);
  });

  it("reports ok for a well-formed --host codex registration parsed from config.toml", () => {
    scratch();
    write("codex-home/config.toml", configToml({ command: "npx", args: GOOD_ARGS }));
    const checks = checkCodex(cxOpts());
    expect(checks.some((c) => c.status === "ok" && /registration/.test(c.name))).toBe(true);
    expect(checks.every((c) => c.status !== "fail")).toBe(true);
  });

  it("reports ok for a registration using the --host=codex single-token form", () => {
    scratch();
    write(
      "codex-home/config.toml",
      configToml({ command: "npx", args: ["-y", "--package=predexec", "predexec-mcp", "--host=codex"] }),
    );
    const checks = checkCodex(cxOpts());
    const fail = checks.find((c) => c.status === "fail" && /--host codex/.test(c.name));
    expect(fail).toBeFalsy();
    expect(checks.some((c) => c.status === "ok" && /registration/.test(c.name))).toBe(true);
  });

  it("warns (fail) when the registration is missing --host codex", () => {
    scratch();
    write("codex-home/config.toml", configToml({ command: "npx", args: ["-y", "--package=predexec", "predexec-mcp"] }));
    const checks = checkCodex(cxOpts());
    const fail = checks.find((c) => c.status === "fail" && /--host codex/.test(c.name));
    expect(fail).toBeTruthy();
    expect(fail!.hint).toContain("--host codex");
  });

  it("warns (fail) when enabled = false", () => {
    scratch();
    write("codex-home/config.toml", configToml({ command: "npx", args: GOOD_ARGS, enabled: false }));
    const checks = checkCodex(cxOpts());
    const fail = checks.find((c) => c.status === "fail" && /enabled = false/.test(c.name));
    expect(fail).toBeTruthy();
  });

  it("warns (fail), naming the file, when config.toml exists but fails to parse", () => {
    scratch();
    write("codex-home/config.toml", "[mcp_servers.predexec\ncommand = \"npx\"\n");
    const checks = checkCodex(cxOpts());
    const fail = checks.find((c) => c.status === "fail" && /does not parse/.test(c.name));
    expect(fail).toBeTruthy();
    expect(fail!.name).toContain(join(tmp, "codex-home", "config.toml"));
    expect(fail!.detail).toBeTruthy();
  });

  it("warns (fail) when the registered command does not resolve on this machine", () => {
    scratch();
    write("codex-home/config.toml", configToml({ command: "totally-not-a-real-binary-xyz", args: GOOD_ARGS }));
    const checks = checkCodex(cxOpts());
    const fail = checks.find((c) => c.status === "fail" && /not found/.test(c.name));
    expect(fail).toBeTruthy();
    expect(fail!.name).toContain("totally-not-a-real-binary-xyz");
  });

  it("prefers `codex mcp get --json` when the real binary is reachable (fake codex fixture): ok", () => {
    scratch();
    mkdirSync(join(tmp, "codex-home"), { recursive: true });
    const fakeCodex = writeFakeCodex();
    const checks = checkCodex(
      cxOpts({
        installed: true,
        codexBin: fakeCodex,
        env: { ...process.env, FAKE_CODEX_SCENARIO: "ok" },
      }),
    );
    expect(checks.some((c) => c.status === "ok" && /codex-cli 0\.149\.1/.test(c.name))).toBe(true);
    expect(checks.some((c) => c.status === "ok" && /registration/.test(c.name))).toBe(true);
    expect(checks.every((c) => c.status !== "fail")).toBe(true);
  });

  it("detects a missing --host codex flag via the json path too", () => {
    scratch();
    mkdirSync(join(tmp, "codex-home"), { recursive: true });
    const fakeCodex = writeFakeCodex();
    const checks = checkCodex(
      cxOpts({
        installed: true,
        codexBin: fakeCodex,
        env: { ...process.env, FAKE_CODEX_SCENARIO: "missing-host" },
      }),
    );
    expect(checks.some((c) => c.status === "fail" && /--host codex/.test(c.name))).toBe(true);
  });

  it("detects enabled = false via the json path too", () => {
    scratch();
    mkdirSync(join(tmp, "codex-home"), { recursive: true });
    const fakeCodex = writeFakeCodex();
    const checks = checkCodex(
      cxOpts({
        installed: true,
        codexBin: fakeCodex,
        env: { ...process.env, FAKE_CODEX_SCENARIO: "disabled" },
      }),
    );
    expect(checks.some((c) => c.status === "fail" && /enabled = false/.test(c.name))).toBe(true);
  });

  it("falls back to not-registered (info) via json when the fake codex reports no such server", () => {
    scratch();
    mkdirSync(join(tmp, "codex-home"), { recursive: true });
    const fakeCodex = writeFakeCodex();
    const checks = checkCodex(
      cxOpts({
        installed: true,
        codexBin: fakeCodex,
        env: { ...process.env, FAKE_CODEX_SCENARIO: "not-registered" },
      }),
    );
    expect(checks.some((c) => c.status === "info" && /not registered/.test(c.name))).toBe(true);
    expect(checks.every((c) => c.status !== "fail")).toBe(true);
  });
});

const skillFrontmatter = (body = "body") => `---\nname: predexec\ndescription: x\n---\n\n${body}\n`;

// A deterministic fixture "package root" so skillCheck's canonical-content
// comparison (I1 fix — bin/predexec.mjs:1366) has something to compare
// against that doesn't depend on this repo's own real packaged SKILL.md
// text. Each harness gets distinct, recognizable wording.
const CANONICAL_BODY: Record<string, string> = {
  claude: "canonical claude wording",
  codex: "canonical codex wording",
  opencode: "canonical opencode wording",
  antigravity: "canonical antigravity wording",
};
const canonicalSkill = (harness: keyof typeof CANONICAL_BODY) => skillFrontmatter(CANONICAL_BODY[harness]);

/** Writes every harness's canonical SKILL.md under a fresh `pkg/` fixture root, at the exact repo-relative paths SKILL_SOURCE_PATHS declares. Returns the fixture root's absolute path. */
function writeCanonicalPackageFixture() {
  for (const harness of Object.keys(CANONICAL_BODY) as (keyof typeof CANONICAL_BODY)[]) {
    write(join("pkg", SKILL_SOURCE_PATHS[harness]), canonicalSkill(harness));
  }
  return join(tmp, "pkg");
}

describe("skill discovery: findPredexecSkills", () => {
  it("finds a SKILL.md one level under a discovery root", () => {
    scratch();
    write("root/predexec/SKILL.md", skillFrontmatter("claude variant"));
    const skills = findPredexecSkills([join(tmp, "root")]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.path).toBe(join(tmp, "root", "predexec", "SKILL.md"));
  });

  it("ignores a SKILL.md whose frontmatter name isn't predexec", () => {
    scratch();
    write("root/other-skill/SKILL.md", "---\nname: something-else\ndescription: x\n---\n");
    expect(findPredexecSkills([join(tmp, "root")])).toHaveLength(0);
  });

  it("ignores a file with no frontmatter at all", () => {
    scratch();
    write("root/predexec/SKILL.md", "not a skill file");
    expect(findPredexecSkills([join(tmp, "root")])).toHaveLength(0);
  });

  it("de-duplicates the same file reached through two identical roots", () => {
    scratch();
    write("root/predexec/SKILL.md", skillFrontmatter());
    expect(findPredexecSkills([join(tmp, "root"), join(tmp, "root")])).toHaveLength(1);
  });

  it("tolerates a missing discovery root", () => {
    scratch();
    expect(findPredexecSkills([join(tmp, "does-not-exist")])).toEqual([]);
  });
});

describe("skillCheck", () => {
  it("is silent (no check at all) when nothing is found and the host isn't registered", () => {
    scratch();
    expect(skillCheck("x", "x", [join(tmp, "nope")], false)).toEqual([]);
  });

  it("hints install-skill when nothing is found but the host is registered", () => {
    scratch();
    const checks = skillCheck("claude code", "claude", [join(tmp, "nope")], true);
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.hint).toContain("install-skill claude");
  });

  // installName "x" has no SKILL_SOURCE_PATHS entry, so readCanonicalSkillText
  // returns null and skillCheck falls back to comparing found copies against
  // each other — these three deliberately exercise that fallback path (the
  // pre-I1-fix behavior, kept for when a real install is corrupted).
  it("reports ok for exactly one skill (fallback path, unknown harness)", () => {
    scratch();
    write("root/predexec/SKILL.md", skillFrontmatter());
    expect(skillCheck("x", "x", [join(tmp, "root")], true)[0]!.status).toBe("ok");
  });

  it("reports info for identical duplicates visible from two roots (fallback path)", () => {
    scratch();
    write("a/predexec/SKILL.md", skillFrontmatter("same"));
    write("b/predexec/SKILL.md", skillFrontmatter("same"));
    const checks = skillCheck("x", "x", [join(tmp, "a"), join(tmp, "b")], true);
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.name).toContain("duplicate copies");
  });

  it("reports fail (`[!]`) for two DIFFERENT skills visible to the same host (fallback path)", () => {
    scratch();
    write("a/predexec/SKILL.md", skillFrontmatter("claude wording"));
    write("b/predexec/SKILL.md", skillFrontmatter("opencode wording"));
    const checks = skillCheck("x", "x", [join(tmp, "a"), join(tmp, "b")], true);
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.name).toContain("multiple different predexec skills visible");
  });
});

describe("skillCheck — canonical-content comparison (I1 fix)", () => {
  it("a lone skill matching this harness's packaged canonical content ⇒ ok", () => {
    scratch();
    const pkg = writeCanonicalPackageFixture();
    write("root/predexec/SKILL.md", canonicalSkill("opencode"));
    const checks = skillCheck("opencode", "opencode", [join(tmp, "root")], true, { packageRoot: pkg });
    expect(checks[0]!.status).toBe("ok");
  });

  it("two copies both matching canonical ⇒ info duplicate, not fail", () => {
    scratch();
    const pkg = writeCanonicalPackageFixture();
    write("a/predexec/SKILL.md", canonicalSkill("opencode"));
    write("b/predexec/SKILL.md", canonicalSkill("opencode"));
    const checks = skillCheck("opencode", "opencode", [join(tmp, "a"), join(tmp, "b")], true, { packageRoot: pkg });
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.name).toContain("duplicate copies");
  });

  it("a LONE skill that does NOT match this harness's canonical content is fail, never ok (the reported gap)", () => {
    scratch();
    const pkg = writeCanonicalPackageFixture();
    write("root/predexec/SKILL.md", canonicalSkill("codex")); // wrong harness's wording, alone in the root
    const checks = skillCheck("opencode", "opencode", [join(tmp, "root")], true, { packageRoot: pkg });
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.name).toContain("wrong harness or stale");
    expect(checks[0]!.hint).toContain("install-skill opencode");
    expect(checks[0]!.hint).toContain("--force");
  });

  it("a stale, hand-edited copy of the harness's own skill ⇒ fail", () => {
    scratch();
    const pkg = writeCanonicalPackageFixture();
    write("root/predexec/SKILL.md", skillFrontmatter("hand-edited, out of date"));
    const checks = skillCheck("opencode", "opencode", [join(tmp, "root")], true, { packageRoot: pkg });
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.name).toContain("wrong harness or stale");
  });

  it("falls back to pairwise comparison when the canonical file can't be read (corrupted install)", () => {
    scratch();
    write("root/predexec/SKILL.md", skillFrontmatter());
    // "opencode" IS a real harness key, but packageRoot points nowhere, so
    // readCanonicalSkillText can't load the packaged file for it.
    const checks = skillCheck("opencode", "opencode", [join(tmp, "root")], true, {
      packageRoot: join(tmp, "does-not-exist"),
    });
    expect(checks[0]!.status).toBe("ok");
  });
});

describe("readCanonicalSkillText", () => {
  it("reads a harness's packaged canonical text from a given package root", () => {
    scratch();
    const pkg = writeCanonicalPackageFixture();
    expect(readCanonicalSkillText("opencode", { packageRoot: pkg })).toBe(canonicalSkill("opencode"));
  });

  it("returns null for an unknown harness or an unreadable package root", () => {
    scratch();
    expect(readCanonicalSkillText("not-a-harness", { packageRoot: join(tmp, "pkg") })).toBeNull();
    expect(readCanonicalSkillText("opencode", { packageRoot: join(tmp, "does-not-exist") })).toBeNull();
  });
});

describe("skill discovery roots", () => {
  it("claudeSkillRoots honors CLAUDE_CONFIG_DIR and adds the project scope", () => {
    const roots = claudeSkillRoots({ home: "/home/u", cwd: "/proj", configDir: "/custom/cfg" });
    expect(roots).toEqual([join("/custom/cfg", "skills"), join("/proj", ".claude", "skills")]);
  });

  it("codexSkillRoots layers .agents/skills from the project (git) root down to cwd", () => {
    scratch();
    const root = join(tmp, "repo");
    const sub = join(root, "sub");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(sub, { recursive: true });
    const roots = codexSkillRoots({ home: join(tmp, "home"), cwd: sub, codexHome: join(tmp, "codex-home") });
    expect(roots).toContain(join(tmp, "home", ".agents", "skills"));
    expect(roots).toContain(join(tmp, "codex-home", "skills"));
    expect(roots).toContain(join(sub, ".codex", "skills"));
    expect(roots).toContain(join(root, ".agents", "skills"));
    expect(roots).toContain(join(sub, ".agents", "skills"));
    expect(roots).toContain(join("/etc", "codex", "skills"));
  });

  it("opencodeSkillRoots includes a project config's skills.paths entries", () => {
    scratch();
    mkdirSync(join(tmp, "proj", ".git"), { recursive: true }); // stop the config walk at proj
    write("proj/opencode.json", JSON.stringify({ skills: { paths: ["custom-skills"] } }));
    const roots = opencodeSkillRoots({ home: join(tmp, "home"), cwd: join(tmp, "proj") });
    expect(roots).toContain(join(tmp, "proj", "custom-skills"));
  });

  it("antigravitySkillRoots covers the project scope and every global gemini location", () => {
    const roots = antigravitySkillRoots({ home: "/home/u", cwd: "/proj" });
    expect(roots).toEqual([
      join("/proj", ".agents", "skills"),
      join("/proj", ".agent", "skills"),
      join("/home/u", ".gemini", "config", "skills"),
      join("/home/u", ".gemini", "antigravity", "skills"),
      join("/home/u", ".gemini", "antigravity-cli", "skills"),
    ]);
  });
});

describe("agentsFileHasRouting", () => {
  it("detects a routing block via marker quorum", () => {
    scratch();
    write("proj/AGENTS.md", "Use predexec for read-only shell operations. mutationStop recovers.");
    expect(agentsFileHasRouting(join(tmp, "proj"))).toBe(true);
  });

  it("is false for an AGENTS.md that merely mentions the name once", () => {
    scratch();
    write("proj/AGENTS.md", "This project uses predexec somewhere.");
    expect(agentsFileHasRouting(join(tmp, "proj"))).toBe(false);
  });

  it("is false when there is no AGENTS.md at all", () => {
    scratch();
    mkdirSync(join(tmp, "proj"), { recursive: true });
    expect(agentsFileHasRouting(join(tmp, "proj"))).toBe(false);
  });
});

describe("doctor — skill checks (claude)", () => {
  const skOpts = (over: Record<string, unknown> = {}) => ({
    home: join(tmp, "home"),
    cwd: join(tmp, "proj"),
    configDir: join(tmp, "home", ".claude"),
    packageRoot: writeCanonicalPackageFixture(),
    ...over,
  });

  it("is silent when unregistered and no skill exists", () => {
    scratch();
    expect(checkClaudeSkill(skOpts(), false)).toEqual([]);
  });

  it("hints install-skill when registered but no skill is found", () => {
    scratch();
    const checks = checkClaudeSkill(skOpts(), true);
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.hint).toContain("install-skill claude");
  });

  it("reports ok once the packaged skill is installed at the global root", () => {
    scratch();
    const opts = skOpts();
    write("home/.claude/skills/predexec/SKILL.md", canonicalSkill("claude"));
    expect(checkClaudeSkill(opts, true)[0]!.status).toBe("ok");
  });

  it("flags a stale, hand-edited copy of the claude skill (I1 fix)", () => {
    scratch();
    const opts = skOpts();
    write("home/.claude/skills/predexec/SKILL.md", skillFrontmatter("hand-edited"));
    const checks = checkClaudeSkill(opts, true);
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.name).toContain("wrong harness or stale");
  });

  it("short-circuits to ok when the plugin form bundles its own skill", () => {
    scratch();
    write("plugin/skills/claude/predexec/SKILL.md", skillFrontmatter());
    const checks = checkClaudeSkill(skOpts({ plugin: { installPath: join(tmp, "plugin") } }), true);
    expect(checks[0]!.status).toBe("ok");
    expect(checks[0]!.name).toContain("bundled with plugin");
  });
});

describe("doctor — skill checks (codex)", () => {
  const cxSkOpts = (over: Record<string, unknown> = {}) => ({
    home: join(tmp, "home"),
    cwd: join(tmp, "proj"),
    codexHome: join(tmp, "codex-home"),
    packageRoot: writeCanonicalPackageFixture(),
    ...over,
  });

  it("flags an AGENTS.md routing block and a skill both being active", () => {
    scratch();
    const opts = cxSkOpts();
    write("proj/AGENTS.md", "Use predexec for read-only shell operations. mutationStop recovers.");
    write("home/.agents/skills/predexec/SKILL.md", canonicalSkill("codex"));
    const checks = checkCodexSkill(opts, true);
    expect(checks.some((c) => c.status === "ok")).toBe(true);
    expect(checks.some((c) => c.status === "info" && /AGENTS\.md/.test(c.name))).toBe(true);
  });

  it("does not mention AGENTS.md when there is no skill at all", () => {
    scratch();
    const opts = cxSkOpts();
    write("proj/AGENTS.md", "Use predexec for read-only shell operations. mutationStop recovers.");
    const checks = checkCodexSkill(opts, true);
    expect(checks.some((c) => /AGENTS\.md/.test(c.name))).toBe(false);
  });

  // I1 fix: a lone WRONG-harness skill sitting in a root codex shares with
  // opencode (`~/.agents/skills`) must not be silently reported ok.
  it("a lone opencode-worded skill in a root codex also scans is [!], not ok", () => {
    scratch();
    const opts = cxSkOpts();
    write("home/.agents/skills/predexec/SKILL.md", canonicalSkill("opencode"));
    const checks = checkCodexSkill(opts, true);
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.name).toContain("wrong harness or stale");
  });
});

describe("doctor — skill checks (opencode)", () => {
  const ocSkOpts = (over: Record<string, unknown> = {}) => ({
    home: join(tmp, "home"),
    cwd: join(tmp, "proj"),
    packageRoot: writeCanonicalPackageFixture(),
    ...over,
  });

  it("flags a stale claude-flavored skill visible alongside opencode's own (cross-host duplicate)", () => {
    scratch();
    const opts = ocSkOpts();
    write("proj/.claude/skills/predexec/SKILL.md", canonicalSkill("claude"));
    write("proj/.opencode/skills/predexec/SKILL.md", canonicalSkill("opencode"));
    const checks = checkOpencodeSkill(opts, true);
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.name).toContain("wrong harness or stale");
  });

  it("reports ok for a single opencode skill with no cross-host overlap", () => {
    scratch();
    const opts = ocSkOpts();
    write("proj/.opencode/skills/predexec/SKILL.md", canonicalSkill("opencode"));
    const checks = checkOpencodeSkill(opts, true);
    expect(checks[0]!.status).toBe("ok");
  });

  // I1 fix: a lone WRONG-harness skill sitting in a root opencode shares with
  // codex (`~/.agents/skills`) must not be silently reported ok just because
  // only one copy was found there.
  it("a lone codex-worded skill in a root opencode also scans is [!], not ok", () => {
    scratch();
    const opts = ocSkOpts();
    write("home/.agents/skills/predexec/SKILL.md", canonicalSkill("codex"));
    const checks = checkOpencodeSkill(opts, true);
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.name).toContain("wrong harness or stale");
  });
});

describe("doctor — skill checks (antigravity)", () => {
  it("skips when there is no sign of antigravity at all", () => {
    scratch();
    expect(checkAntigravitySkill({ home: join(tmp, "home") })[0]!.status).toBe("skip");
  });

  it("hints install-skill when ~/.gemini exists but no skill is found", () => {
    scratch();
    mkdirSync(join(tmp, "home", ".gemini"), { recursive: true });
    const checks = checkAntigravitySkill({ home: join(tmp, "home"), cwd: join(tmp, "proj") });
    expect(checks[0]!.status).toBe("info");
    expect(checks[0]!.hint).toContain("install-skill antigravity");
  });

  it("reports ok once the skill is installed", () => {
    scratch();
    const pkg = writeCanonicalPackageFixture();
    write("home/.gemini/config/skills/predexec/SKILL.md", canonicalSkill("antigravity"));
    const checks = checkAntigravitySkill({ home: join(tmp, "home"), cwd: join(tmp, "proj"), packageRoot: pkg });
    expect(checks[0]!.status).toBe("ok");
  });

  it("flags a stale, hand-edited copy of the antigravity skill (I1 fix)", () => {
    scratch();
    const pkg = writeCanonicalPackageFixture();
    write("home/.gemini/config/skills/predexec/SKILL.md", skillFrontmatter("hand-edited"));
    const checks = checkAntigravitySkill({ home: join(tmp, "home"), cwd: join(tmp, "proj"), packageRoot: pkg });
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.name).toContain("wrong harness or stale");
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
