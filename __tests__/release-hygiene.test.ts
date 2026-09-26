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
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureBuild } from "./helpers/ensure-build.ts";

// Every file scripts/sync-plugin-version.mjs writes. Sync tests must never
// touch these directly — see the "sync-plugin-version.mjs" describe block
// below, which snapshots them before its tests run and asserts byte-identity
// after, and only ever exercises the script against a --root'd tmp copy.
const SYNCED_MANIFESTS = [
  "package.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  ".codex-plugin/mcp.json",
  "antigravity-plugin/plugin.json",
  "antigravity-plugin/mcp_config.json",
];

const SYNC_SCRIPT = resolve("scripts/sync-plugin-version.mjs");

function copyManifestsToTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "predexec-sync-"));
  for (const rel of SYNCED_MANIFESTS) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(rel, dest);
  }
  return dir;
}

/** Sets a JSON file's top-level `version` field to a stale placeholder. */
function desyncVersion(manifestPath: string) {
  const json = JSON.parse(readFileSync(manifestPath, "utf8"));
  json.version = "0.0.0-stale";
  writeFileSync(manifestPath, JSON.stringify(json, null, 2) + "\n", "utf8");
}

/** Sets the `--package=predexec@...` npx pin inside an mcpServers.predexec.args array to stale. */
function desyncNpxPin(manifestPath: string) {
  const json = JSON.parse(readFileSync(manifestPath, "utf8"));
  const args = json.mcpServers.predexec.args as string[];
  const i = args.findIndex((a) => a.startsWith("--package=predexec"));
  args[i] = "--package=predexec@0.0.0-stale";
  writeFileSync(manifestPath, JSON.stringify(json, null, 2) + "\n", "utf8");
}

function runSync(root: string) {
  execFileSync(process.execPath, [SYNC_SCRIPT, "--root", root], { stdio: "pipe" });
}

function runSyncAsync(root: string): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SYNC_SCRIPT, "--root", root], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise(code));
  });
}

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

  it("antigravity-plugin/plugin.json and mcp_config.json parse and stay in step with package.json's version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    const plugin = JSON.parse(readFileSync(join("antigravity-plugin", "plugin.json"), "utf8")) as {
      name: string;
      version: string;
    };
    // agy's plugin.json schema documents only `name` as meaningful (see
    // ~/.gemini/antigravity/builtin/skills/agy-customizations/docs/plugins.md,
    // read-only) — the directory name is what config.json's `plugins.<dir>`
    // map and the `<plugin>_<server>` MCP namespacing key off, so this must
    // stay "predexec" to match the shipped directory.
    expect(plugin.name).toBe("predexec");
    expect(plugin.version).toBe(pkg.version);

    const mcp = JSON.parse(readFileSync(join("antigravity-plugin", "mcp_config.json"), "utf8")) as {
      mcpServers: { predexec: { command: string; args: string[] } };
    };
    const server = mcp.mcpServers.predexec;
    expect(server.command).toBe("npx");
    expect(server.args).toContain(`--package=predexec@${pkg.version}`);
    // `--host antigravity` selects mcp/policy-antigravity.ts; without it the
    // server silently falls back to Claude Code policy/stats behavior.
    expect(server.args).toContain("--host");
    expect(server.args[server.args.indexOf("--host") + 1]).toBe("antigravity");
  });

  it("agy plugin validate antigravity-plugin passes, when the agy CLI is on PATH", () => {
    // Read-only: `agy plugin validate` only inspects the manifest/skills/mcp
    // config files on disk — it does not touch ~/.gemini or register
    // anything. Never run `agy plugin install` or `agy mcp add` here.
    let agyPath: string;
    try {
      agyPath = execFileSync(process.platform === "win32" ? "where" : "which", ["agy"], { stdio: "pipe" })
        .toString()
        .trim()
        .split("\n")[0]!;
    } catch {
      return; // no agy CLI on PATH — nothing to check
    }
    if (!agyPath) return;
    const output = execFileSync(agyPath, ["plugin", "validate", "antigravity-plugin"], { stdio: "pipe" }).toString();
    expect(output).toMatch(/\[ok\]/);
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

describe("sync-plugin-version.mjs", () => {
  // F2 (docs/superpowers/specs/2026-09-26-escape-hardening.md): the old tests
  // planted "0.0.0-stale" into the REAL tracked manifests and restored them in
  // a `finally` block. Two concurrent vitest runs (or even two workers in one
  // run) racing that same real file corrupt each other's read of it. Every
  // test below instead runs the script against a --root'd tmp copy, and this
  // describe block snapshots every tracked manifest before its tests run and
  // asserts byte-identity afterward, so a regression back to in-place writes
  // fails loudly here instead of showing up as cross-run flake.
  let before: Record<string, string>;
  const tmpDirs: string[] = [];

  beforeAll(() => {
    before = Object.fromEntries(SYNCED_MANIFESTS.map((rel) => [rel, readFileSync(rel, "utf8")]));
  });

  afterEach(() => {
    let dir: string | undefined;
    while ((dir = tmpDirs.pop())) rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const rel of SYNCED_MANIFESTS) {
      expect(readFileSync(rel, "utf8"), `${rel} must be untouched by sync-plugin-version.mjs tests`).toBe(
        before[rel],
      );
    }
  });

  it("syncs .claude-plugin/plugin.json and marketplace.json to package.json's version", () => {
    const dir = copyManifestsToTmp();
    tmpDirs.push(dir);
    // Deliberately desync first, so this proves the script actually rewrites
    // the file rather than merely observing a value that already matched.
    desyncVersion(join(dir, ".claude-plugin", "plugin.json"));

    runSync(dir);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
    const plugin = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")) as {
      version: string;
      mcpServers: { predexec: { args: string[] } };
    };
    const marketplace = JSON.parse(readFileSync(join(dir, ".claude-plugin", "marketplace.json"), "utf8")) as {
      version: string;
    };
    expect(plugin.version).toBe(pkg.version);
    expect(marketplace.version).toBe(pkg.version);
    expect(plugin.mcpServers.predexec.args).toContain(`--package=predexec@${pkg.version}`);
  });

  it("also syncs .codex-plugin/plugin.json and mcp.json's npx pin", () => {
    const dir = copyManifestsToTmp();
    tmpDirs.push(dir);
    const pluginPath = join(dir, ".codex-plugin", "plugin.json");
    const mcpPath = join(dir, ".codex-plugin", "mcp.json");
    desyncVersion(pluginPath);
    desyncNpxPin(mcpPath);

    runSync(dir);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
    const syncedPlugin = JSON.parse(readFileSync(pluginPath, "utf8")) as { version: string };
    const syncedMcp = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: { predexec: { args: string[] } };
    };
    expect(syncedPlugin.version).toBe(pkg.version);
    expect(syncedMcp.mcpServers.predexec.args).toContain(`--package=predexec@${pkg.version}`);
  });

  it("also syncs antigravity-plugin/plugin.json and mcp_config.json's npx pin", () => {
    const dir = copyManifestsToTmp();
    tmpDirs.push(dir);
    const pluginPath = join(dir, "antigravity-plugin", "plugin.json");
    const mcpPath = join(dir, "antigravity-plugin", "mcp_config.json");
    desyncVersion(pluginPath);
    desyncNpxPin(mcpPath);

    runSync(dir);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
    const syncedPlugin = JSON.parse(readFileSync(pluginPath, "utf8")) as { version: string };
    const syncedMcp = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: { predexec: { args: string[] } };
    };
    expect(syncedPlugin.version).toBe(pkg.version);
    expect(syncedMcp.mcpServers.predexec.args).toContain(`--package=predexec@${pkg.version}`);
  });

  it("runs safely against two separate --root targets at once, without touching each other or the repo", async () => {
    const dirA = copyManifestsToTmp();
    const dirB = copyManifestsToTmp();
    tmpDirs.push(dirA, dirB);
    desyncVersion(join(dirA, ".claude-plugin", "plugin.json"));
    desyncVersion(join(dirB, ".codex-plugin", "plugin.json"));

    const [codeA, codeB] = await Promise.all([runSyncAsync(dirA), runSyncAsync(dirB)]);

    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    const pluginA = JSON.parse(readFileSync(join(dirA, ".claude-plugin", "plugin.json"), "utf8")) as {
      version: string;
    };
    const pluginB = JSON.parse(readFileSync(join(dirB, ".codex-plugin", "plugin.json"), "utf8")) as {
      version: string;
    };
    expect(pluginA.version).toBe(pkg.version);
    expect(pluginB.version).toBe(pkg.version);
  });
});

describe("no local machine paths in tracked docs", () => {
  // The repo has a PUBLIC remote. Research notes and plans are written from live
  // measurements, so an absolute home or scratch path (which carries the OS
  // username) is easy to paste in by accident. Use ~/…, <repo>/…, <scratchpad>/… instead.
  it("docs/, scripts/ and README.md contain no /Users/ or /private/tmp/ paths", () => {
    // PLAN.md at the repo root was archived under docs/superpowers/plans/ (see
    // CLAUDE.md's Current state), so it's already covered by the "docs" pathspec below.
    const tracked = execFileSync("git", ["ls-files", "-z", "--", "docs", "scripts", "README.md"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    expect(tracked.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of tracked) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (line.includes("/Users/") || line.includes("/private/tmp/")) hits.push(`${file}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("source loads under node's strip-only TypeScript mode", () => {
  // CLAUDE.md: local source commands run TypeScript directly. Node's type
  // stripping rejects non-erasable syntax (parameter properties, enums), so
  // one `constructor(private readonly s)` broke importing policy.ts and the
  // MCP server from source. tsconfig's erasableSyntaxOnly keeps it that way.
  it.each(["policy.ts", "mcp/server.ts", "mcp/toml-lite.ts", "yaml-frontmatter.ts", "core/index.ts"])("%s", (file) => {
    const out = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(resolve(file)).href)}); console.log("loaded")`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(out.trim()).toBe("loaded");
  });

  it("tsconfig enforces erasableSyntaxOnly", () => {
    const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8")) as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions.erasableSyntaxOnly).toBe(true);
  });
});
