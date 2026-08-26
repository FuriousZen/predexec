import { execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

type Json = Record<string, any>;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("packed artifact verification", () => {
  let packDir: string;
  let extractDir: string;
  let tarballPath: string;

  beforeAll(() => {
    // Ensure fresh build before packing
    execSync("npm run build", { cwd: root, stdio: "pipe" });

    packDir = mkdtempSync(join(tmpdir(), "px-pack-"));
    extractDir = join(packDir, "extracted");
    mkdirSync(extractDir, { recursive: true });

    // Pack to temporary tarball
    const packOutput = execSync(`npm pack --pack-destination="${packDir}"`, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(tmpdir(), "px-npm-cache") },
    }).trim();

    const tarballName = packOutput.split("\n").filter(Boolean).pop()!;
    tarballPath = join(packDir, tarballName);

    // Extract tarball (tar strips the top-level 'package/' dir when --strip-components=1 is used)
    execSync(`tar -xzf "${tarballPath}" -C "${extractDir}" --strip-components=1`, {
      stdio: "pipe",
    });

    // Symlink root node_modules so the isolated extracted directory can resolve its dependencies
    execSync(`ln -s "${join(root, "node_modules")}" "${join(extractDir, "node_modules")}"`);
  });

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
    expect(list).toContain("skills/predexec-claude/SKILL.md");
    expect(list).toContain("configs/opencode/AGENTS.md");
    expect(list).toContain(".claude-plugin/plugin.json");
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

  it("invokes extracted predexec CLI (doctor & --version)", () => {
    const bin = join(extractDir, "bin", "predexec.mjs");
    const ver = execSync(`node "${bin}" --version`, { encoding: "utf8" }).trim();
    expect(ver).toMatch(/^\d+\.\d+\.\d+/);

    const doc = execSync(`node "${bin}" doctor`, { encoding: "utf8" });
    expect(doc).toContain("predexec doctor");
  });

  it("invokes extracted predexec-mcp binary over stdio (initialize, list, call)", async () => {
    const bin = join(extractDir, "bin", "predexec-mcp.mjs");
    const testDir = mkdtempSync(join(tmpdir(), "px-pack-test-run-"));
    const noSettings = mkdtempSync(join(tmpdir(), "px-pack-nosettings-"));

    const child = spawn(process.execPath, [bin], {
      cwd: testDir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: noSettings },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pending = new Map<number, { resolve: (msg: Json) => void; reject: (err: Error) => void }>();
    let nextId = 1;
    let buffer = "";
    let stderr = "";

    child.stderr!.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      for (const { reject } of pending.values()) {
        reject(err);
      }
      pending.clear();
    });

    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        for (const { reject } of pending.values()) {
          reject(new Error(`child process exited with code ${code}: ${stderr}`));
        }
        pending.clear();
      }
    });

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            const { resolve } = pending.get(msg.id)!;
            pending.delete(msg.id);
            resolve(msg);
          }
        } catch {
          // ignore non-json
        }
      }
    });

    const request = (method: string, params?: Json): Promise<Json> => {
      const id = nextId++;
      const answered = new Promise<Json>((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
      return answered;
    };

    const notify = (method: string, params?: Json): void => {
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
    };

    try {
      const initRes = await request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "predexec-pack-test", version: "1" },
      });
      expect(initRes.result.serverInfo.name).toBe("predexec");
      expect(initRes.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);

      notify("notifications/initialized");

      const listRes = await request("tools/list");
      const tools = listRes.result.tools as Json[];
      expect(tools.some((t) => t.name === "predexec")).toBe(true);

      const callRes = await request("tools/call", {
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
      child.kill("SIGTERM");
      rmSync(testDir, { recursive: true, force: true });
      rmSync(noSettings, { recursive: true, force: true });
    }
  });
});
