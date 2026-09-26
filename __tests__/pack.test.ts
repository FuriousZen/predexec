import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { ensureBuild } from "./helpers/ensure-build.ts";
import { spawnMcpClient } from "./helpers/stdio-client.ts";

type Json = Record<string, any>;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// npm install (Step 1) is the slow part of this suite's beforeAll; give it
// real headroom rather than tripping vitest's default hook timeout on a cold
// cache / first network fetch.
const INSTALL_HOOK_TIMEOUT_MS = 120_000;

describe("packed artifact verification", () => {
  let packDir: string;
  let extractDir: string;
  let installDir: string;
  let tarballPath: string;
  const npmCache = join(tmpdir(), "px-npm-cache");

  beforeAll(() => {
    // Ensure fresh build before packing. force:true because packing must be
    // fresh regardless of mtimes; still takes the cross-process lock because
    // release-hygiene.test.ts's beforeAll can be building dist/ concurrently
    // in a separate vitest worker. See helpers/ensure-build.ts.
    ensureBuild({ force: true });

    packDir = mkdtempSync(join(tmpdir(), "px-pack-"));
    extractDir = join(packDir, "extracted");
    installDir = join(packDir, "install");
    mkdirSync(extractDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });

    // Pack to temporary tarball. --ignore-scripts skips npm's own `prepack`
    // lifecycle hook here, deliberately: `prepack` is
    // "npm run typecheck && npm run build" (package.json), a SECOND,
    // independent `clean-build.mjs` invocation that is NOT covered by
    // ensureBuild's cross-process lock above. With multiple `vitest run`
    // processes running pack.test.ts concurrently (e.g. scripts/stress-test.mjs),
    // their un-locked `prepack` builds can race each other on clean-build.mjs's
    // fixed-name scratch dir and briefly corrupt `dist/` for whichever one
    // loses — this is what caused a flaky "Cannot find module .../dist/core/types.js"
    // failure here under concurrency. `ensureBuild({force:true})` above already
    // guarantees a fresh, lock-protected `dist/` before we ever call `npm pack`,
    // so skipping prepack loses nothing here; the real prepack path (a bare
    // `npm pack`/`npm publish` outside this test suite) is untouched and still
    // runs it.
    const packOutput = execSync(`npm pack --ignore-scripts --pack-destination="${packDir}"`, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: npmCache },
    }).trim();

    const tarballName = packOutput.split("\n").filter(Boolean).pop()!;
    tarballPath = join(packDir, tarballName);

    // Extract tarball (tar strips the top-level 'package/' dir when --strip-components=1 is used)
    // Used ONLY by the file-list/file-content inspection tests below — they
    // need no node_modules at all, so this directory never gets one.
    execSync(`tar -xzf "${tarballPath}" -C "${extractDir}" --strip-components=1`, {
      stdio: "pipe",
    });

    // Real `npm install` of the packed tarball into a fresh prefix — the
    // execution tests (CLI, MCP stdio) run against THIS layout, not a
    // symlink into the dev tree. A symlinked node_modules can never catch a
    // runtime import missing from `dependencies`; a real install can, and it
    // also exercises `isDirectInvocation`'s realpath guard under its real
    // condition: npm installs `bin` entries as symlinks under
    // node_modules/.bin, so process.argv[1] is the symlink while
    // import.meta.url is the realpath'd module URL.
    //
    // --prefer-offline resolves from npmCache first but still permits a
    // network fetch on a cache miss (it does not forbid network — only
    // dropping this flag entirely would be a "fallback"). If the install
    // fails for any reason, it must fail loudly here — no symlink fallback.
    const stubPkg = { name: "pack-smoke", private: true };
    writeFileSync(join(installDir, "package.json"), JSON.stringify(stubPkg), "utf8");
    execSync(`npm install --omit=dev --no-audit --no-fund --prefer-offline "${tarballPath}"`, {
      cwd: installDir,
      stdio: "pipe",
      env: { ...process.env, npm_config_cache: npmCache },
    });
  }, INSTALL_HOOK_TIMEOUT_MS);

  afterAll(() => {
    if (packDir) {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("packed package.json points to compiled dist artifacts and removes jiti", () => {
    const pkg = JSON.parse(readFileSync(join(extractDir, "package.json"), "utf8"));

    expect(pkg.main).toBe("dist/.opencode/plugins/predexec.js");
    expect(pkg.pi.extensions).toEqual(["./dist/.pi/extension/index.js"]);
    expect(pkg.dependencies.jiti).toBeUndefined();
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/server", "zod"].sort());
  });

  it("tarball contains dist/ files and no root TypeScript source files", () => {
    const list = execSync(`tar -tf "${tarballPath}"`, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((p) => p.replace(/^package\//, ""));

    // Expected files
    expect(list).toContain("dist/.pi/extension/index.js");
    expect(list).toContain("dist/.opencode/plugins/predexec.js");
    expect(list).toContain("dist/mcp/server.js");
    expect(list).toContain("dist/core/index.js");
    expect(list).toContain("dist/adapter-runtime.js");
    expect(list).toContain("bin/predexec.mjs");
    expect(list).toContain("bin/predexec-mcp.mjs");
    expect(list).toContain(".pi/skills/predexec/SKILL.md");
    expect(list).toContain("skills/claude/predexec/SKILL.md");
    expect(list).toContain("skills/codex/predexec/SKILL.md");
    expect(list).toContain("skills/opencode/predexec/SKILL.md");
    expect(list).toContain("antigravity-plugin/skills/predexec/SKILL.md");
    expect(list).toContain("antigravity-plugin/plugin.json");
    expect(list).toContain("antigravity-plugin/mcp_config.json");
    expect(list).toContain("configs/opencode/AGENTS.md");
    expect(list).toContain("configs/antigravity/AGENTS.md");
    expect(list).toContain(".claude-plugin/plugin.json");
    expect(list).toContain(".codex-plugin/plugin.json");
    expect(list).toContain(".codex-plugin/mcp.json");
    expect(list).toContain("README.md");
    expect(list).toContain("package.json");

    // Source TypeScript directories/files should NOT be in the tarball
    expect(list.some((p) => p.startsWith("core/") && p.endsWith(".ts"))).toBe(false);
    expect(list.some((p) => p.startsWith("mcp/") && p.endsWith(".ts"))).toBe(false);
    expect(list.some((p) => p.startsWith(".pi/extension/") && p.endsWith(".ts"))).toBe(false);
    expect(list.some((p) => p.startsWith(".opencode/plugins/") && p.endsWith(".ts"))).toBe(false);
    expect(list.some((p) => /^steering\.ts$/.test(p))).toBe(false);
    expect(list.some((p) => /^stats\.ts$/.test(p))).toBe(false);
    expect(list.some((p) => /^policy\.ts$/.test(p))).toBe(false);
    expect(list.some((p) => /^adapter-runtime\.ts$/.test(p))).toBe(false);
  });

  /**
   * `pnpm run build` (scripts/clean-build.mjs) now compiles into a scratch
   * dir and atomically swaps it in as `dist/`, specifically so a stale file a
   * PAST source layout emitted (e.g. the pre-Task-5 `dist/command-inspection.js`,
   * from before that module moved into `core/shell/`) can never survive a
   * rebuild — a plain in-place `tsc` only ever adds or overwrites, so it never
   * would have caught this on its own. `dist/` mirrors the source tree
   * exactly (verified: every current `dist/**\/*.js` maps 1:1 to a same-named
   * `.ts` one level up), so this asserts that invariant directly on the
   * packed artifact — the release-hygiene backstop if the build script ever
   * regresses.
   */
  it("every packaged dist/ .js file maps to a real source .ts file (catches stale compiled output)", () => {
    const distRoot = join(extractDir, "dist");
    const jsFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".js")) jsFiles.push(full.slice(distRoot.length + 1));
      }
    };
    walk(distRoot);
    expect(jsFiles.length).toBeGreaterThan(0);

    const orphaned = jsFiles.filter((rel) => !existsSync(join(root, rel.replace(/\.js$/, ".ts"))));
    expect(orphaned).toEqual([]);
  });

  it("no packaged runtime JS file imports .ts or jiti", () => {
    const getFiles = (dir: string): string[] => {
      const entries = readdirSync(dir);
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          files.push(...getFiles(full));
        } else {
          files.push(full);
        }
      }
      return files;
    };

    const runtimeFiles = [
      ...getFiles(join(extractDir, "dist")),
      ...getFiles(join(extractDir, "bin")),
    ].filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));

    expect(runtimeFiles.length).toBeGreaterThan(0);

    for (const file of runtimeFiles) {
      const content = readFileSync(file, "utf8");
      // Check for .ts imports
      expect(content).not.toMatch(/from\s+["'][^"']+\.ts["']/);
      expect(content).not.toMatch(/import\s*\(\s*["'][^"']+\.ts["']\s*\)/);
      // Check for jiti
      expect(content).not.toMatch(/from\s+["']jiti(\/[^"']*)?["']/);
      expect(content).not.toMatch(/import\s*\(\s*["']jiti(\/[^"']*)?["']\s*\)/);
    }

    // The `main` entry specifically must be ESM: a leftover untracked, typeless
    // .opencode/package.json on the release machine flips tsc's NodeNext emit
    // to CJS for exactly this file (0.3.0 shipped broken this way — Bun/Node
    // both reject it at runtime). Assert the compiled artifact itself, not just
    // absence of .ts/jiti imports.
    const pkg = JSON.parse(readFileSync(join(extractDir, "package.json"), "utf8"));
    const mainSrc = readFileSync(join(extractDir, pkg.main), "utf8");
    expect(mainSrc).toContain("export default");
    expect(mainSrc).not.toMatch(/\bexports\.default\b/);
  });

  it("real npm install is dependency-scoped, not the dev tree", () => {
    // Proves Step 1 installed FROM the packed tarball's declared `dependencies`
    // (a real resolve) rather than any tree that happens to contain the dev
    // checkout's devDependencies. @modelcontextprotocol/server is a declared
    // runtime dependency and must be present; @earendil-works (the scope
    // holding the pi devDependency, never a runtime dependency) must be absent.
    expect(existsSync(join(installDir, "node_modules", "@modelcontextprotocol", "server"))).toBe(true);
    expect(existsSync(join(installDir, "node_modules", "@earendil-works"))).toBe(false);
    expect(existsSync(join(installDir, "node_modules", ".bin", "predexec"))).toBe(true);
    expect(existsSync(join(installDir, "node_modules", ".bin", "predexec-mcp"))).toBe(true);
  });

  it("invokes installed predexec CLI (doctor & --version)", () => {
    const ver = execSync(`node_modules/.bin/predexec --version`, { cwd: installDir, encoding: "utf8" }).trim();
    expect(ver).toMatch(/^\d+\.\d+\.\d+/);

    const doc = execSync(`node_modules/.bin/predexec doctor`, { cwd: installDir, encoding: "utf8" });
    expect(doc).toContain("predexec doctor");
  });

  it("invokes installed predexec-mcp binary over stdio (initialize, list, call)", async () => {
    const bin = join(installDir, "node_modules", ".bin", "predexec-mcp");
    const testDir = mkdtempSync(join(tmpdir(), "px-pack-test-run-"));
    const noSettings = mkdtempSync(join(tmpdir(), "px-pack-nosettings-"));

    const client = spawnMcpClient(bin, {
      cwd: testDir,
      env: { CLAUDE_CONFIG_DIR: noSettings },
    });

    try {
      const initRes = await client.request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "predexec-pack-test", version: "1" },
      });
      expect(initRes.result.serverInfo.name).toBe("predexec");
      expect(initRes.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);

      client.notify("notifications/initialized");

      const listRes = await client.request("tools/list");
      const tools = listRes.result.tools as Json[];
      expect(tools.some((t) => t.name === "predexec")).toBe(true);

      const callRes = await client.request("tools/call", {
        name: "predexec",
        arguments: {
          plan: {
            root: "a",
            nodes: [{ id: "a", commands: ["echo hello-from-packed-mcp"] }],
          },
        },
      });

      const text = callRes.result?.content?.[0]?.text ?? "";
      expect(text).toContain("node a (exit 0)");
      expect(text).toContain("hello-from-packed-mcp");
      expect(callRes.result.isError).toBeUndefined();
    } finally {
      client.kill();
      rmSync(testDir, { recursive: true, force: true });
      rmSync(noSettings, { recursive: true, force: true });
    }
  });
});
