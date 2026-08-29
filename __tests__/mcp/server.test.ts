import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type McpServer } from "@modelcontextprotocol/server";
import { createServer, DESCRIPTION, TOOL_NAME } from "../../mcp/server.ts";
import { spawnMcpClient } from "../helpers/stdio-client.ts";

type Json = Record<string, any>;

/** Connect and complete the handshake — the SDK rejects requests sent before `initialize`. */
async function connected(opts: Parameters<typeof createServer>[0] = {}) {
  const server = createServer(opts);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await clientTransport.start();

  const pending = new Map<number, (msg: Json) => void>();
  let nextId = 1;

  clientTransport.onmessage = (message: Json) => {
    if (typeof message.id === "number") {
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  };

  const request = (method: string, params?: Json): Promise<Json> => {
    const id = nextId++;
    const answered = new Promise<Json>((resolve) => pending.set(id, resolve));
    void clientTransport.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return answered;
  };

  await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "predexec-test", version: "0" },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { server, request, clientTransport };
}

/**
 * A scratch dir standing in for BOTH the user config dir and the managed
 * settings dir, so the machine's real Claude Code permission rules never reach
 * a test. Without it a developer's own `deny` rule would fail the suite.
 */
const noSettings = mkdtempSync(join(tmpdir(), "px-mcp-nosettings-"));
const policyOptions = { env: { CLAUDE_CONFIG_DIR: noSettings }, managedDir: noSettings };

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "px-mcp-"));
  writeFileSync(join(dir, "marker.txt"), "hello from predexec\n");
  return dir;
};

const callPredexec = async (request: (m: string, p?: Json) => Promise<Json>, plan: unknown) =>
  request("tools/call", { name: TOOL_NAME, arguments: { plan } });

const textOf = (response: Json): string => response.result?.content?.[0]?.text ?? "";

describe("mcp server — tool registration", () => {
  it("advertises exactly one tool, named predexec, with a `plan` object argument", async () => {
    const { request } = await connected({ cwd: project(), policy: policyOptions });
    const listed = await request("tools/list");

    const tools = listed.result.tools as Json[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe(TOOL_NAME);
    // Shape only: z.unknown() converts to a non-obvious JSON Schema, and pinning
    // that conversion would fail on an SDK bump without anything being wrong.
    expect(tools[0]!.inputSchema.type).toBe("object");
    expect(Object.keys(tools[0]!.inputSchema.properties)).toContain("plan");
  });

  it("the plan argument keeps its authoring guidance through the schema conversion", async () => {
    // `z.unknown()` carries no structure at all, so `.describe()` IS the plan
    // schema for the model. A converter that dropped it would leave the tool
    // callable and useless, with nothing failing anywhere.
    const { request } = await connected({ cwd: project(), policy: policyOptions });
    const listed = await request("tools/list");

    const plan = (listed.result.tools as Json[])[0]!.inputSchema.properties.plan;
    expect(plan.description).toContain('"exit == 0"');
    expect(plan.description).toContain('"stdout =~ /regex/"');
    expect(plan.description).toContain('"file exists <path>"');
    expect(plan.description).toContain('{tool:"read"');
    expect(plan.description).toContain("dependency symlinks below node_modules are the sole exception");
    expect(plan.description).toContain("do not provide kernel-atomic protection against concurrent parent-directory replacement");
  });

  it("the description carries the shared steering prose (the only always-on channel here)", async () => {
    const { request } = await connected({ cwd: project(), policy: policyOptions });
    const listed = await request("tools/list");

    const description = (listed.result.tools as Json[])[0]!.description as string;
    expect(description).toBe(DESCRIPTION);
    expect(description).toContain("Use predexec for all read-only shell operations");
    expect(description).toContain("Do not build depth on unverified paths");
    // Claude Code is the one harness where the host's Bash rules do not reach
    // us, so the description has to say predexec enforces them itself.
    expect(description).toContain("hard-stops before running");
  });
});

describe("mcp server — running a plan", () => {
  it("runs a depth-0 plan end to end and returns the transcript", async () => {
    const dir = project();
    const { request } = await connected({ cwd: dir, policy: policyOptions });

    const response = await callPredexec(request, {
      root: "a",
      nodes: [{ id: "a", commands: ["echo ran-in-shell", { tool: "read", path: "marker.txt" }] }],
    });

    const text = textOf(response);
    expect(text).toContain(`# cwd: ${dir}`);
    expect(text).toContain("node a (exit 0)");
    expect(text).toContain("ran-in-shell");
    expect(text).toContain("hello from predexec");
    expect(response.result.isError).toBeUndefined();
  });

  it("a mutating node hard-stops before running", async () => {
    const { request } = await connected({ cwd: project(), policy: policyOptions });

    const response = await callPredexec(request, {
      root: "a",
      nodes: [{ id: "a", commands: ["rm -rf marker.txt"] }],
    });

    expect(textOf(response)).toContain("MUTATION HARD-STOP (not run)");
  });
});

describe("mcp server — failures return a result instead of throwing", () => {
  it("a malformed plan returns the coercion error, flagged isError", async () => {
    const { request } = await connected({ cwd: project(), policy: policyOptions });

    const response = await callPredexec(request, { nodes: [{ id: "a", commands: [] }] });

    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(true);
    expect(textOf(response)).toContain("predexec expected a JSON object with `root`");
  });

  it("a plan with an invalid cwd is returned as a named error result", async () => {
    const { request } = await connected({ cwd: project(), policy: policyOptions });

    const response = await callPredexec(request, {
      root: "a",
      nodes: [{ id: "a", commands: ["echo hi"] }],
      cwd: 5,
    });

    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(true);
    expect(textOf(response)).toContain("cwd must be a relative directory inside the session root");
  });

  it("an invalid plan structure is reported as an error result, not a bare transcript", async () => {
    const { request } = await connected({ cwd: project(), policy: policyOptions });

    const response = await callPredexec(request, { root: "missing", nodes: [{ id: "a", commands: [] }] });

    expect(response.result.isError).toBe(true);
    expect(textOf(response)).toContain("plan validation failed");
  });
});

describe("mcp server — Claude Code permission policy", () => {
  it("a native Read deny rule stops before predexec reads the file", async () => {
    const dir = project();
    writeFileSync(join(dir, ".env"), "secret\n");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), '{"permissions":{"deny":["Read(./.env)"]}}');
    const { request } = await connected({ cwd: dir, policy: policyOptions });

    const response = await callPredexec(request, {
      root: "a",
      nodes: [{ id: "a", commands: [{ tool: "read", path: ".env" }] }],
    });
    const text = textOf(response);
    expect(text).toContain("POLICY HARD-STOP (not run)");
    expect(text).toContain("read:.env");
    expect(text).toContain("'./.env'");
    expect(text).not.toContain("secret");
  });

  it("a deny rule in .claude/settings.json produces a policyStop before the command runs", async () => {
    const dir = project();
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), '{"permissions":{"deny":["Bash(cat *)"]}}');
    const { request } = await connected({ cwd: dir, policy: policyOptions });

    const response = await callPredexec(request, {
      root: "a",
      nodes: [{ id: "a", commands: ["cat marker.txt"] }],
    });

    const text = textOf(response);
    expect(text).toContain("POLICY HARD-STOP (not run)");
    expect(text).toContain("'cat *'");
    // The stop must land BEFORE execution — the file's contents never appear.
    expect(text).not.toContain("hello from predexec");
    expect(text).not.toContain("node a (exit");
  });

  it("an `ask` rule stops too — predexec cannot prompt mid-walk", async () => {
    const dir = project();
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), '{"permissions":{"ask":["Bash(cat *)"]}}');
    const { request } = await connected({ cwd: dir, policy: policyOptions });

    const response = await callPredexec(request, {
      root: "a",
      nodes: [{ id: "a", commands: ["cat marker.txt"] }],
    });

    expect(textOf(response)).toContain("POLICY HARD-STOP (not run)");
  });

  it("without permission rules the same command runs normally", async () => {
    const dir = project();
    const { request } = await connected({ cwd: dir, policy: policyOptions });

    const response = await callPredexec(request, {
      root: "a",
      nodes: [{ id: "a", commands: ["cat marker.txt"] }],
    });

    expect(textOf(response)).toContain("node a (exit 0)");
    expect(textOf(response)).toContain("hello from predexec");
  });
});

/**
 * Packaging is part of the adapter, not around it: an unlisted `files` entry or
 * an undeclared runtime dependency ships an install that is silently broken —
 * the server simply never loads, with no failing build to warn anyone.
 */
describe("mcp server — packaging and plugin wiring", () => {
  const root = join(__dirname, "..", "..");
  const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));

  it("package.json ships every path the MCP adapter loads at runtime", () => {
    const pkg = readJson("package.json");
    for (const entry of ["dist", "bin", "skills", ".claude-plugin"]) {
      expect(pkg.files).toContain(entry);
    }
    expect(pkg.bin["predexec-mcp"]).toBe("./bin/predexec-mcp.mjs");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/server", "zod"].sort());
  });

  it("the plugin manifest invokes the bin through its OWN package name", () => {
    // Inlined into plugin.json on purpose: a root .mcp.json is a live
    // project-scope registration for anyone who opens this repo in Claude Code,
    // and it shipped into every consumer's node_modules.
    const server = readJson(".claude-plugin/plugin.json").mcpServers.predexec;
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("npx");
    // `npx -y predexec-mcp` resolves a REGISTRY PACKAGE called predexec-mcp,
    // which does not exist — the bin lives inside `predexec`. Without
    // --package the entry 404s on every machine.
    expect(server.args).toContain("--package=predexec");
    expect(server.args).toContain("predexec-mcp");
  });

  it("the plugin manifest names the plugin and points at that server declaration", () => {
    const manifest = readJson(".claude-plugin", "plugin.json");
    expect(manifest.name).toBe("predexec");
    expect(typeof manifest.mcpServers).toBe("object");
    // The manifest version is hand-written and would otherwise drift silently
    // on the next release bump.
    expect(manifest.version).toBe(readJson("package.json").version);
  });

  it("the Claude Code skill's frontmatter name matches its directory", () => {
    const skill = readFileSync(join(root, "skills", "predexec-claude", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\n(?:[\s\S]*?\n)?name: predexec-claude\n/);
    expect(skill).toMatch(/\ndescription: \S/);
  });

  /**
   * The pi skill lives under `.pi/skills/` and the root `skills/` dir (Claude
   * Code's auto-discovered plugin root) holds ONLY the Claude Code skill — so
   * pi's skill loader and Claude Code's `skills/` root are isolated from each
   * other and neither harness receives the other's prompt instructions.
   */
  it("pi.skills resolves to real directories under .pi/skills, isolated from the Claude Code skills root", () => {
    const pkg = readJson("package.json");
    const skillDirs: string[] = pkg.pi.skills;
    expect(skillDirs.length).toBeGreaterThan(0);
    for (const rel of skillDirs) {
      expect(rel.replace(/^\.\//, "")).toMatch(/^\.pi\/skills/);
      expect(statSync(join(root, rel)).isDirectory()).toBe(true);
    }

    const piSkillEntries = readdirSync(join(root, ".pi", "skills")).sort();
    expect(piSkillEntries).toEqual(["predexec"]);

    const rootSkillEntries = readdirSync(join(root, "skills")).sort();
    expect(rootSkillEntries).toEqual(["predexec-claude"]);
  });
});

describe("mcp server — spawned stdio launcher", () => {
  it("spawns the entrypoint, completes handshake, lists tools, and executes a depth-0 plan over stdio", async () => {
    const dir = project();
    const binPath = join(__dirname, "..", "..", "bin", "predexec-mcp.mjs");
    const client = spawnMcpClient(binPath, {
      cwd: dir,
      env: { ...policyOptions.env, CLAUDE_CONFIG_DIR: noSettings },
    });

    try {
      const initRes = await client.request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "predexec-stdio-test", version: "1" },
      });
      expect(initRes.result.serverInfo.name).toBe("predexec");

      client.notify("notifications/initialized");

      const listRes = await client.request("tools/list");
      const tools = listRes.result.tools as Json[];
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe(TOOL_NAME);
      // Codex CLI's per-call approval mode prompts on every call to a tool
      // lacking `readOnlyHint: true` (unannotated => destructive assumed).
      // predexec genuinely never writes/installs/deletes, so it must be
      // annotated read-only over the wire, on this protocol era too.
      expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
      expect(tools[0]!.annotations?.destructiveHint).toBeFalsy();

      const callRes = await client.request("tools/call", {
        name: TOOL_NAME,
        arguments: {
          plan: {
            root: "a",
            nodes: [{ id: "a", commands: ["echo ran-in-spawned-stdio", { tool: "read", path: "marker.txt" }] }],
          },
        },
      });

      const text = textOf(callRes);
      expect(text).toContain(`# cwd: ${realpathSync(dir)}`);
      expect(text).toContain("node a (exit 0)");
      expect(text).toContain("ran-in-spawned-stdio");
      expect(text).toContain("hello from predexec");
      expect(callRes.result.isError).toBeUndefined();

      // STDOUT IS THE PROTOCOL: every newline-separated chunk on stdout must parse as valid JSON-RPC
      const allLines = client.rawStdoutChunks.join("").split("\n").filter((l) => l.trim().length > 0);
      for (const line of allLines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      client.kill();
    }
  });

  /**
   * Claude Code itself still opens with a 2025-era protocolVersion. Both tests
   * above only ever exercise LATEST_PROTOCOL_VERSION, so the one path real
   * users hit was untested (F4) — this pins it against the SDK's `legacy:
   * 'serve'` default (serveStdio's default), which pins the connection to a
   * 2025-era instance from the same factory rather than rejecting it.
   */
  it("completes the handshake and runs a plan under a legacy (2025-era) protocolVersion", async () => {
    const dir = project();
    const binPath = join(__dirname, "..", "..", "bin", "predexec-mcp.mjs");
    const client = spawnMcpClient(binPath, {
      cwd: dir,
      env: { ...policyOptions.env, CLAUDE_CONFIG_DIR: noSettings },
    });

    try {
      const initRes = await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "predexec-legacy-test", version: "1" },
      });
      expect(initRes.result.protocolVersion).toMatch(/^2025-/);

      client.notify("notifications/initialized");

      const listRes = await client.request("tools/list");
      const tools = listRes.result.tools as Json[];
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe(TOOL_NAME);
      expect(tools[0]!.inputSchema.type).toBe("object");
      // Same annotation contract must survive the legacy (2025-06-18) protocol
      // era — this is the era Claude Code itself actually opens with.
      expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
      expect(tools[0]!.annotations?.destructiveHint).toBeFalsy();

      const callRes = await client.request("tools/call", {
        name: TOOL_NAME,
        arguments: {
          plan: { root: "a", nodes: [{ id: "a", commands: ["printf predexec-legacy-ok"] }] },
        },
      });

      expect(textOf(callRes)).toContain("predexec-legacy-ok");
      expect(callRes.result.isError).toBeUndefined();
    } finally {
      client.kill();
    }
  });
});

describe("mcp server — launcher `--host` flag", () => {
  it("--host=codex selects the Codex execpolicy adapter: a forbidden rule stops the command, an unmatched one still runs", async () => {
    // NOTE: the brief's illustrative rule forbids `git push`, but `git push` is
    // ALSO caught by core/destructive.ts's mutation heuristic (the git
    // history-mutating-verb blocklist) — and engine.ts checks mutation BEFORE
    // policy (mutationStop always wins for that exact command, on every host,
    // policy adapter irrelevant). Proving the CODEX policy path specifically
    // requires a command the mutation heuristic passes through cleanly, so
    // this uses `cat` (a declared read-only head) forbidden via the rule
    // instead — same shape as the sibling Claude Code policy test above
    // ("cat marker.txt" + a `Bash(cat *)` deny rule).
    const dir = project();
    const codexHome = mkdtempSync(join(tmpdir(), "px-codex-home-"));
    mkdirSync(join(codexHome, "rules"));
    writeFileSync(join(codexHome, "rules", "deny-cat.rules"), 'prefix_rule(pattern=["cat"], decision="forbidden")\n');

    const binPath = join(__dirname, "..", "..", "bin", "predexec-mcp.mjs");
    // `--host=codex` (equals form) is exercised here; `--host codex` (two-token
    // form) is the other accepted spelling per the interface contract.
    const client = spawnMcpClient(binPath, {
      cwd: dir,
      args: ["--host=codex"],
      env: { CODEX_HOME: codexHome },
    });

    try {
      const initRes = await client.request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "predexec-codex-test", version: "1" },
      });
      expect(initRes.result.serverInfo.name).toBe("predexec");
      client.notify("notifications/initialized");

      const catRes = await client.request("tools/call", {
        name: TOOL_NAME,
        arguments: { plan: { root: "a", nodes: [{ id: "a", commands: ["cat marker.txt"] }] } },
      });
      const catText = textOf(catRes);
      expect(catText).toContain("POLICY HARD-STOP (not run)");
      expect(catText).toContain("cat");
      // The stop must land BEFORE execution — the file's contents never appear.
      expect(catText).not.toContain("hello from predexec");

      const okRes = await client.request("tools/call", {
        name: TOOL_NAME,
        arguments: { plan: { root: "a", nodes: [{ id: "a", commands: ["printf ok"] }] } },
      });
      expect(textOf(okRes)).toContain("ok");
      expect(okRes.result.isError).toBeUndefined();
    } finally {
      client.kill();
    }
  });

  it("an unrecognized --host value exits 1 with a usage line on stderr, before any protocol output", async () => {
    const binPath = join(__dirname, "..", "..", "bin", "predexec-mcp.mjs");
    const child = spawn(process.execPath, [binPath, "--host", "bogus"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (c: string) => (stdout += c));
    child.stderr!.on("data", (c: string) => (stderr += c));

    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/usage: predexec-mcp/);
    expect(stderr).toContain("--host");
    expect(stdout).toBe("");
  });
});
