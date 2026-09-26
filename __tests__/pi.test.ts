/**
 * Characterization of the pi adapter's registration contract with a FAKE
 * `ExtensionAPI` — no real `@earendil-works/pi-coding-agent` host involved.
 *
 * This locks in what the pi extension actually hands the host today (tool
 * shape, prompt guidance, the `tool_result` nudge hook, and `tool.execute`'s
 * result shape) for both the source and the compiled dist/ entry, so a
 * registration-contract change cannot ship silently.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OUTPUT_CAP } from "../core/runner.ts";
import { appendProgressText } from "../.pi/extension/index.ts";
import {
  CONDITION_KINDS,
  DEFAULT_MAX_DEPTH,
  MAX_OPERATIONS_PER_NODE,
  RESOURCE_LIMIT_DESCRIPTION,
} from "../plan-language.ts";
import * as adapterRuntime from "../adapter-runtime.ts";

const { readToolCwds } = vi.hoisted(() => ({ readToolCwds: [] as string[] }));

vi.mock("@earendil-works/pi-coding-agent", () => {
  const createTool = () => ({
    execute: async () => ({ content: [{ type: "text", text: "inside" }] }),
  });
  return {
    createReadTool: (cwd: string) => {
      readToolCwds.push(cwd);
      return createTool();
    },
    createGrepTool: createTool,
    createFindTool: createTool,
    createLsTool: createTool,
  };
});
import predexecSource from "../.pi/extension/index.ts";
// Requires a prior `pnpm run build` — the compiled variant is asserted against the same contract as the source.
import predexecCompiled from "../dist/.pi/extension/index.js";

type Handler = (event: any) => any;

/** Minimal stand-in for pi's `ExtensionAPI`: captures `on`/`registerTool` calls. */
function createFakeApi() {
  const events = new Map<string, Handler>();
  let tool: any;
  const api = {
    on(name: string, handler: Handler) {
      events.set(name, handler);
    },
    registerTool(def: any) {
      tool = def;
    },
  };
  return { api: api as any, events, getTool: () => tool as any };
}

const variants = [
  { name: "source (.pi/extension/index.ts)", predexec: predexecSource },
  { name: "compiled (dist/.pi/extension/index.js)", predexec: predexecCompiled },
];

describe("pi progress buffering", () => {
  it("caps accumulated progress text and marks truncation", () => {
    const text = appendProgressText("", "x".repeat(100_000));
    expect(text.length).toBeLessThanOrEqual(OUTPUT_CAP + 64);
    expect(text).toContain("…[truncated");
  });
});

describe.each(variants)("pi extension ($name) — registration contract (fake ExtensionAPI)", ({ predexec }) => {
  it("registers a `predexec` tool with the expected schema and prompt guidance", () => {
    const { api, events, getTool } = createFakeApi();
    predexec(api);
    const tool = getTool();

    expect(tool.name).toBe("predexec");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.properties.nodes.type).toBe("array");
    expect(tool.parameters.properties.nodes.items.properties.commands.maxItems).toBe(MAX_OPERATIONS_PER_NODE);
    expect(tool.parameters.properties.maxDepth.maximum).toBe(DEFAULT_MAX_DEPTH);
    expect(tool.parameters.properties.maxDepth.description).toContain(String(DEFAULT_MAX_DEPTH));
    expect(tool.parameters.properties.maxDepth.description).toContain("rejected");
    expect(tool.parameters.properties.maxDepth.description).not.toContain("clamped");
    expect(tool.parameters.properties.cwd.description).toContain("inside the session root");
    expect(tool.parameters.properties.cwd.description).toContain("absolute");
    expect(tool.parameters.properties.nodes.items.properties.commands.items.description).toContain(RESOURCE_LIMIT_DESCRIPTION);
    expect(tool.parameters.properties.nodes.items.properties.commands.items.description).toContain("grep patterns are capped at 8192 characters");
    for (const kind of CONDITION_KINDS) {
      expect(tool.parameters.properties.nodes.items.properties.edges.items.properties.when.description).toContain(kind);
    }
    expect(tool.promptGuidelines.join("\n")).toContain("mutationStop/noEdgeMatch");
    expect(events.has("tool_result")).toBe(true);
  });
});

describe.each(variants)("pi extension ($name) — tool.execute", ({ predexec }) => {
  it("runs a depth-0 printf plan and reports the transcript, stoppedReason, and path", async () => {
    const { api, getTool } = createFakeApi();
    predexec(api);
    const tool = getTool();

    const cwd = mkdtempSync(join(tmpdir(), "px-pi-"));
    const updates: any[] = [];
    const result = await tool.execute(
      "tc1",
      { root: "a", nodes: [{ id: "a", commands: ["printf hi"] }] },
      undefined,
      (u: any) => updates.push(u),
      { cwd },
    );

    const text = result.content[0].text as string;
    expect(text).toContain("node a (exit 0)");
    expect(text).toContain("hi");
    expect(result.details.stoppedReason).toBe("leaf");
    expect(result.details.pathTaken).toEqual(["a"]);
    expect(updates.length).toBeGreaterThan(0);
  });

  it("throws on a coercion error instead of returning it as a normal result (pi renders a returned object as success)", async () => {
    const { api, getTool } = createFakeApi();
    predexec(api);
    const tool = getTool();

    const cwd = mkdtempSync(join(tmpdir(), "px-pi-"));
    await expect(
      tool.execute("tc2", { bad: "plan" }, undefined, () => {}, { cwd }),
    ).rejects.toThrow("predexec expected a JSON object with `root`");
  });

  it("throws on an unexpected engine error instead of returning it as a normal result", async () => {
    const { api, getTool } = createFakeApi();
    predexec(api);
    const tool = getTool();

    const cwd = mkdtempSync(join(tmpdir(), "px-pi-"));
    await expect(
      tool.execute(
        "tc3",
        { root: "a", nodes: [{ id: "a", commands: ["echo"] }], cwd: 123 },
        undefined,
        () => {},
        { cwd },
      ),
    ).rejects.toThrow("cwd must be a relative directory inside the session root");
  });

  it("constructs native read tools at the effective plan cwd", async () => {
    readToolCwds.length = 0;
    const { api, getTool } = createFakeApi();
    predexec(api);
    const tool = getTool();

    const cwd = mkdtempSync(join(tmpdir(), "px-pi-"));
    const sub = join(cwd, "sub");
    const result = await tool.execute(
      "tc4",
      { root: "a", cwd: "sub", nodes: [{ id: "a", commands: [{ tool: "read", path: "inside.txt" }] }] },
      undefined,
      () => {},
      { cwd },
    );

    expect(result.details.stoppedReason).toBe("leaf");
    expect(readToolCwds).toEqual([sub]);
  });

  it("does not accumulate command output when progress updates are omitted", async () => {
    const { api, getTool } = createFakeApi();
    predexec(api);
    const tool = getTool();

    const cwd = mkdtempSync(join(tmpdir(), "px-pi-"));
    const result = await tool.execute(
      "tc5",
      {
        root: "a",
        nodes: [{ id: "a", commands: ["node -e 'process.stdout.write(\"x\".repeat(100000))'"] }],
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.details.stoppedReason).toBe("leaf");
    expect(result.content[0].text).toContain("…[truncated");
  });

  it("caps every cumulative progress snapshot across a multi-node walk", async () => {
    const { api, getTool } = createFakeApi();
    predexec(api);
    const tool = getTool();

    const cwd = mkdtempSync(join(tmpdir(), "px-pi-"));
    const updates: any[] = [];
    const nodes = Array.from({ length: 9 }, (_, index) => ({
      id: `n${index}`,
      commands: ["node -e 'process.stdout.write(\"x\".repeat(8192))'"],
      ...(index < 8 ? { edges: [{ when: { kind: "always" }, to: `n${index + 1}` }] } : {}),
    }));
    const result = await tool.execute("tc6", { root: "n0", nodes }, undefined, (u: any) => updates.push(u), { cwd });

    expect(result.details.pathTaken).toHaveLength(9);
    expect(Math.max(...updates.map((u) => u.content[0].text.length))).toBeLessThanOrEqual(OUTPUT_CAP + 64);
  });
});

describe("pi extension — progress callback registration", () => {
  it("does not register progress callbacks when onUpdate is omitted", async () => {
    const execute = vi.spyOn(adapterRuntime, "executeAdapterPlan");
    const { api, getTool } = createFakeApi();
    predexecSource(api);
    const tool = getTool();

    const cwd = mkdtempSync(join(tmpdir(), "px-pi-"));
    await tool.execute(
      "tc7",
      { root: "a", nodes: [{ id: "a", commands: ["printf hi"] }] },
      undefined,
      undefined,
      { cwd },
    );

    const options = execute.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(options.onProgress).toBeUndefined();
    expect(options.onCommandOutput).toBeUndefined();
    execute.mockRestore();
  });
});

describe.each(variants)("pi extension ($name) — tool_result nudge hook", ({ predexec }) => {
  it("appends the batching nudge after a read-only bash command", async () => {
    const { api, events } = createFakeApi();
    predexec(api);
    const hook = events.get("tool_result")!;

    const event = {
      toolName: "bash",
      input: { command: "cat foo.txt" },
      content: [{ type: "text", text: "contents" }],
    };
    const out = await hook(event);

    expect(out).toBeDefined();
    const text = out.content.map((c: any) => c.text).join("");
    expect(text).toContain("[predexec] Batch read-only commands in one predexec call");
  });

  it("does not append the nudge after a mutating bash command", async () => {
    const { api, events } = createFakeApi();
    predexec(api);
    const hook = events.get("tool_result")!;

    const event = {
      toolName: "bash",
      input: { command: "rm -rf foo" },
      content: [{ type: "text", text: "done" }],
    };
    const out = await hook(event);

    expect(out).toBeUndefined();
  });

  it("does not append the nudge after an errored bash result", async () => {
    const { api, events } = createFakeApi();
    predexec(api);
    const hook = events.get("tool_result")!;

    const event = {
      toolName: "bash",
      isError: true,
      input: { command: "cat foo.txt" },
      content: [{ type: "text", text: "no such file" }],
    };
    const out = await hook(event);

    expect(out).toBeUndefined();
  });

  it("appends the nudge after a read-only powershell command", async () => {
    const { api, events } = createFakeApi();
    predexec(api);
    const hook = events.get("tool_result")!;

    const event = {
      toolName: "powershell",
      isError: false,
      input: { command: "Get-Content foo.txt" },
      content: [{ type: "text", text: "contents" }],
    };
    const out = await hook(event);

    expect(out).toBeDefined();
    const text = out.content.map((c: any) => c.text).join("");
    expect(text).toContain("[predexec] Batch read-only commands in one predexec call");
  });
});
