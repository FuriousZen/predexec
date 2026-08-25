/**
 * Characterization of the pi adapter's registration contract with a FAKE
 * `ExtensionAPI` — no real `@earendil-works/pi-coding-agent` host involved.
 *
 * This locks in what the pi extension actually hands the host today (tool
 * shape, prompt guidance, the `tool_result` nudge hook, and `tool.execute`'s
 * result shape) so a later simplification pass can trust these tests instead
 * of preserving the current source incidentally.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import predexec from "../.pi/extension/index.ts";

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

describe("pi extension — registration contract (fake ExtensionAPI)", () => {
  it("registers a `predexec` tool with the expected schema and prompt guidance", () => {
    const { api, events, getTool } = createFakeApi();
    predexec(api);
    const tool = getTool();

    expect(tool.name).toBe("predexec");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.properties.nodes.type).toBe("array");
    expect(tool.promptGuidelines.join("\n")).toContain("mutationStop/noEdgeMatch");
    expect(events.has("tool_result")).toBe(true);
  });
});

describe("pi extension — tool.execute", () => {
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
});

describe("pi extension — tool_result nudge hook", () => {
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
});
