import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, DESCRIPTION, TOOL_NAME } from "../../mcp/server.ts";

type Json = Record<string, any>;

/**
 * A mock transport, not a spawned client: the server is driven by handing
 * JSON-RPC frames to `onmessage` and capturing what it sends back. That covers
 * the registration path a unit call would skip (schema conversion, argument
 * validation, result serialization) without a child process — and without the
 * real StdioServerTransport writing frames onto vitest's stdout.
 */
function connectMock(server: McpServer) {
  const pending = new Map<number, (msg: Json) => void>();
  let nextId = 1;

  const transport = {
    async start() {},
    async send(message: Json) {
      const resolve = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    },
    async close() {},
    onmessage: undefined as ((m: Json) => void) | undefined,
  };

  const request = (method: string, params?: Json): Promise<Json> => {
    const id = nextId++;
    const answered = new Promise<Json>((resolve) => pending.set(id, resolve));
    transport.onmessage!({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return answered;
  };

  return { transport, request };
}

/** Connect and complete the handshake — the SDK rejects requests sent before `initialize`. */
async function connected(opts: Parameters<typeof createServer>[0] = {}) {
  const server = createServer(opts);
  const { transport, request } = connectMock(server);
  await server.connect(transport as never);
  await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "predexec-test", version: "0" },
  });
  transport.onmessage!({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { server, request };
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

  it("a plan that trips the ENGINE is caught too, not just one that trips coercion", async () => {
    // coercePlan does not type-check `cwd`, so a non-string one reaches
    // path.resolve() inside runPlanTree and throws a TypeError. The sibling
    // adapters wrap only coercePlan, so this escapes there; here it must come
    // back as a named result.
    const { request } = await connected({ cwd: project(), policy: policyOptions });

    const response = await callPredexec(request, {
      root: "a",
      nodes: [{ id: "a", commands: ["echo hi"] }],
      cwd: 5,
    });

    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(true);
    expect(textOf(response)).toContain("the plan walk failed unexpectedly");
    expect(textOf(response)).toContain("Fall back to normal tool calling");
  });

  it("an invalid plan structure is reported as an error result, not a bare transcript", async () => {
    const { request } = await connected({ cwd: project(), policy: policyOptions });

    const response = await callPredexec(request, { root: "missing", nodes: [{ id: "a", commands: [] }] });

    expect(response.result.isError).toBe(true);
    expect(textOf(response)).toContain("plan validation failed");
  });
});

describe("mcp server — Claude Code permission policy", () => {
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
    for (const entry of ["mcp", "bin", "core", "skills", ".claude-plugin", "steering.ts", "stats.ts"]) {
      expect(pkg.files).toContain(entry);
    }
    expect(pkg.bin["predexec-mcp"]).toBe("./bin/predexec-mcp.mjs");
    // Both are runtime imports of the launcher/server path. jiti especially:
    // Node refuses to strip types under node_modules, so an install without it
    // cannot load mcp/server.ts at all.
    expect(Object.keys(pkg.dependencies)).toContain("@modelcontextprotocol/sdk");
    expect(Object.keys(pkg.dependencies)).toContain("jiti");
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
});
