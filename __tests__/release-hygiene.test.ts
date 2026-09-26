/**
 * Release hygiene guards.
 *
 * 1. `.claude-plugin/plugin.json` carries its own `version` field, which `npm
 *    version` does NOT bump — the `version` lifecycle script (package.json)
 *    syncs it. This test catches the two files drifting apart (as happened at
 *    0.2.0 → 0.3.0).
 * 2. The test suite executes real plans through `executeAdapterPlan`, whose
 *    stats recorder appends to the REAL `~/.local/state/predexec/stats.jsonl`
 *    unless `PREDEXEC_STATE_DIR` is redirected. vitest.config.ts must pin it
 *    to a throwaway dir for the whole suite, or every run pollutes live stats
 *    (seen as "double-logged" policyStop rows: one per policy test per run).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureBuild } from "./helpers/ensure-build.ts";

describe("release hygiene", () => {
  it("plugin.json version matches package.json", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    const plugin = JSON.parse(readFileSync(join(".claude-plugin", "plugin.json"), "utf8")) as { version: string };
    expect(plugin.version).toBe(pkg.version);
  });

  it("suite-wide PREDEXEC_STATE_DIR isolation keeps tests out of real stats", () => {
    const dir = process.env.PREDEXEC_STATE_DIR;
    expect(dir, "vitest.config.ts must set test.env.PREDEXEC_STATE_DIR").toBeTruthy();
    expect(dir).not.toBe(join(homedir(), ".local", "state", "predexec"));
  });

  it("plugin.json declares an author and scopes skills to the Claude Code subtree", () => {
    // `skills` ADDS to (never replaces) the default `skills/` scan
    // (https://code.claude.com/docs/en/plugins-reference#fields), and both the
    // default scan and a manifest `skills` entry only look one level into the
    // directory they're given for `<name>/SKILL.md`. This repo's skills/<harness>/
    // predexec/SKILL.md layout is two levels below `skills/`, so the bare default
    // scan of the plugin root finds nothing at all — without this field the
    // plugin bundles zero skills. Pointing `skills` at "./skills/claude/"
    // resolves the harness-specific subtree only; codex/opencode/pi/antigravity
    // skills stay invisible to Claude Code.
    const plugin = JSON.parse(readFileSync(join(".claude-plugin", "plugin.json"), "utf8")) as {
      author?: { name?: string };
      skills?: string;
    };
    expect(plugin.author?.name).toBeTruthy();
    expect(plugin.skills).toBe("./skills/claude/");
  });

  it("plugin.json's npx invocation pins --package to the current package.json version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    const plugin = JSON.parse(readFileSync(join(".claude-plugin", "plugin.json"), "utf8")) as {
      mcpServers: { predexec: { args: string[] } };
    };
    expect(plugin.mcpServers.predexec.args).toContain(`--package=predexec@${pkg.version}`);
  });

  it("marketplace.json lists the predexec plugin sourced from the repository root", () => {
    const marketplace = JSON.parse(readFileSync(join(".claude-plugin", "marketplace.json"), "utf8")) as {
      name: string;
      owner: { name?: string };
      plugins: Array<{ name: string; source: string }>;
    };
    expect(marketplace.owner?.name).toBeTruthy();
    const entry = marketplace.plugins.find((p) => p.name === "predexec");
    expect(entry?.source).toBe("./");
  });

  it("sync-plugin-version.mjs syncs both plugin.json and marketplace.json to package.json's version", () => {
    execFileSync(process.execPath, ["scripts/sync-plugin-version.mjs"], { stdio: "pipe" });
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    const plugin = JSON.parse(readFileSync(join(".claude-plugin", "plugin.json"), "utf8")) as {
      version: string;
      mcpServers: { predexec: { args: string[] } };
    };
    const marketplace = JSON.parse(readFileSync(join(".claude-plugin", "marketplace.json"), "utf8")) as {
      version: string;
    };
    expect(plugin.version).toBe(pkg.version);
    expect(marketplace.version).toBe(pkg.version);
    expect(plugin.mcpServers.predexec.args).toContain(`--package=predexec@${pkg.version}`);
  });

  it("there is no root .mcp.json (a live Claude Code project-scope registration)", () => {
    expect(existsSync(join(".mcp.json"))).toBe(false);
  });

  it(".codex-plugin/plugin.json and mcp.json parse and point at each other correctly", () => {
    const plugin = JSON.parse(readFileSync(join(".codex-plugin", "plugin.json"), "utf8")) as {
      name: string;
      version: string;
      mcpServers: string;
      skills: string;
    };
    expect(plugin.mcpServers).toBe("./.codex-plugin/mcp.json");
    // Codex resolves manifest paths relative to the plugin ROOT (the directory
    // containing `.codex-plugin/`), never relative to `.codex-plugin/` itself —
    // see docs/research/codex-plugin.md §1. `skills` must point one level above
    // the harness-specific `predexec/SKILL.md` so Codex's one-level skill scan
    // finds it, and must scope to codex/ only so it never sees skills/claude/ or
    // skills/opencode/ (Controller ruling R4 — verified in the same doc).
    expect(plugin.skills).toBe("./skills/codex/");

    const mcp = JSON.parse(readFileSync(join(".codex-plugin", "mcp.json"), "utf8")) as {
      mcpServers: { predexec: { command: string; args: string[]; env_vars: string[] } };
    };
    const server = mcp.mcpServers.predexec;
    expect(server.command).toBe("npx");
    // `--host codex` selects the Codex policy/stats adapter (mcp/policy-codex.ts);
    // without it predexec silently falls back to Claude Code behavior (CX-4/steering.ts).
    expect(server.args).toContain("--host");
    expect(server.args[server.args.indexOf("--host") + 1]).toBe("codex");
    // CX-4: Codex's MCP child process env starts EMPTY and is populated only from
    // DEFAULT_ENV_VARS plus this list (docs/research/codex-plugin.md §2) — CODEX_HOME
    // is not in DEFAULT_ENV_VARS, so without this the policy reader silently falls
    // back to ~/.codex even when the user has a custom CODEX_HOME set.
    expect(server.env_vars).toContain("CODEX_HOME");
  });

  it(".agents/plugins/marketplace.json lists the predexec plugin sourced from the repository root", () => {
    const marketplace = JSON.parse(readFileSync(join(".agents", "plugins", "marketplace.json"), "utf8")) as {
      name: string;
      plugins: Array<{ name: string; source: { source: string; path: string } }>;
    };
    const entry = marketplace.plugins.find((p) => p.name === "predexec");
    // "." / "./" resolve to the marketplace root itself (docs/research/codex-plugin.md §1,
    // §3 live check) — this repo is the plugin, mirroring .claude-plugin/marketplace.json's
    // own `source: "./"` convention.
    expect(entry?.source).toEqual({ source: "local", path: "./" });
  });

  it("sync-plugin-version.mjs also syncs .codex-plugin/plugin.json and mcp.json's npx pin", () => {
    const pluginPath = join(".codex-plugin", "plugin.json");
    const mcpPath = join(".codex-plugin", "mcp.json");
    const originalPlugin = readFileSync(pluginPath, "utf8");
    const originalMcp = readFileSync(mcpPath, "utf8");
    try {
      // Deliberately desync both files first, so this test proves the script
      // actually rewrites them rather than merely observing values that
      // already happened to match package.json's version.
      const plugin = JSON.parse(originalPlugin);
      plugin.version = "0.0.0-stale";
      writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n", "utf8");
      const mcp = JSON.parse(originalMcp);
      const npxArgs = mcp.mcpServers.predexec.args;
      npxArgs[npxArgs.findIndex((a: string) => a.startsWith("--package=predexec"))] =
        "--package=predexec@0.0.0-stale";
      writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n", "utf8");

      execFileSync(process.execPath, ["scripts/sync-plugin-version.mjs"], { stdio: "pipe" });

      const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
      const syncedPlugin = JSON.parse(readFileSync(pluginPath, "utf8")) as { version: string };
      const syncedMcp = JSON.parse(readFileSync(mcpPath, "utf8")) as {
        mcpServers: { predexec: { args: string[] } };
      };
      expect(syncedPlugin.version).toBe(pkg.version);
      expect(syncedMcp.mcpServers.predexec.args).toContain(`--package=predexec@${pkg.version}`);
    } finally {
      writeFileSync(pluginPath, originalPlugin, "utf8");
      writeFileSync(mcpPath, originalMcp, "utf8");
    }
  });

  it("claude plugin validate . passes, when the claude CLI is on PATH", () => {
    let claudePath: string;
    try {
      claudePath = execFileSync(process.platform === "win32" ? "where" : "which", ["claude"], { stdio: "pipe" })
        .toString()
        .trim()
        .split("\n")[0]!;
    } catch {
      return; // no claude CLI on PATH — nothing to check
    }
    if (!claudePath) return;
    // Read-only check: validates the manifest/marketplace files on disk, no
    // marketplace add/install and no change to the user's own Claude config.
    const output = execFileSync(claudePath, ["plugin", "validate", "."], { stdio: "pipe" }).toString();
    expect(output).toMatch(/Validation passed/);
  });

  beforeAll(() => {
    // Serialized across processes: pack.test.ts's beforeAll can run concurrently
    // in a separate vitest worker and also builds dist/. See ensure-build.ts.
    ensureBuild();
  });

  it("compiled opencode main entry is ESM and exposes default.server (real Node, no vitest interop)", () => {
    const main = JSON.parse(readFileSync("package.json", "utf8")).main as string;
    const url = pathToFileURL(resolve(main)).href;
    // vitest's esbuild CJS interop honors __esModule and hides exactly this class
    // of breakage (0.3.0 shipped a CJS main that Bun/Node reject) — so assert in
    // a clean Node subprocess, the way real hosts load it.
    const script = `const m = await import(${JSON.stringify(url)}); if (typeof m.default?.server !== "function") { console.error("default.server is " + typeof m.default?.server); process.exit(1); }`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
  });
});
