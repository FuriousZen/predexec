/**
 * Real-host validation of the pi adapter's PI-1..PI-4 fixes (PI-6): loads the
 * COMPILED extension through pi's actual extension loader
 * (`@earendil-works/pi-coding-agent`'s `discoverAndLoadExtensions`) instead of
 * the fake `ExtensionAPI` stand-in in pi.test.ts, so a real registration
 * mismatch — something the real host would reject that the fake API happens
 * to tolerate — cannot hide behind it.
 *
 * `validateToolArguments`, the function pi's own tool-call pipeline runs
 * immediately after `prepareArguments`, is internal to pi's bundled CLI: it
 * is not part of the package's public `exports` map (a deep import throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` — verified against 0.87.1) and ships no
 * public type, so it cannot be imported directly. The closest available real
 * substitute is `typebox` itself — the schema library pi's internal validator
 * is built on (`typebox` is a direct dependency of
 * `@earendil-works/pi-coding-agent`; pinned here to the exact version pi
 * 0.87.1 ships) — checking the registered tool's real `parameters` schema
 * against `prepareArguments`'s real output the same way pi's own validator
 * would.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = resolve(root, "dist/.pi/extension/index.js");

type ToolResultHandler = (event: unknown) => Promise<unknown>;

describe("pi extension — real host (discoverAndLoadExtensions)", () => {
  let tool: any;
  let toolResultHandlers: ToolResultHandler[];

  beforeAll(async () => {
    const cwd = mkdtempSync(join(tmpdir(), "px-pi-host-"));
    const loaded = await discoverAndLoadExtensions([extensionPath], cwd, cwd);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);

    const registered = loaded.extensions[0]!.tools.get("predexec");
    expect(registered).toBeDefined();
    tool = registered!.definition;

    toolResultHandlers = (loaded.extensions[0]!.handlers.get("tool_result") ?? []) as ToolResultHandler[];
    expect(toolResultHandlers.length).toBeGreaterThan(0);
  });

  it("registers `predexec` with a prepareArguments hook", () => {
    expect(tool.name).toBe("predexec");
    expect(typeof tool.prepareArguments).toBe("function");
    expect(typeof tool.execute).toBe("function");
  });

  it("prepareArguments recovers a double-encoded `nodes` string into a schema-valid plan (PI-1)", () => {
    const prepared = tool.prepareArguments({ root: "a", nodes: JSON.stringify([{ id: "a", commands: ["ls"] }]) });
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
  });

  it("prepareArguments recovers a whole-plan JSON string into a schema-valid plan (PI-1)", () => {
    const prepared = tool.prepareArguments(JSON.stringify({ root: "a", nodes: [{ id: "a", commands: ["ls"] }] }));
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
  });

  it("prepareArguments wraps a bare `commands` string into a single-element array (PI-1)", () => {
    const prepared = tool.prepareArguments({ root: "a", nodes: [{ id: "a", commands: "ls" }] });
    expect(prepared.nodes[0].commands).toEqual(["ls"]);
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
  });

  it("prepareArguments never throws — a genuinely malformed plan passes through unchanged for pi's own validation to report", () => {
    const args = { nope: true };
    expect(() => tool.prepareArguments(args)).not.toThrow();
    expect(tool.prepareArguments(args)).toEqual(args);
    expect(Value.Check(tool.parameters, tool.prepareArguments(args))).toBe(false);
  });

  it("execute() throws for an engine stoppedReason:error result, per pi's contract for a failed tool result (PI-3)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "px-pi-host-"));
    await expect(tool.execute("id1", { bad: "plan" }, undefined, undefined, { cwd })).rejects.toThrow(
      "predexec expected a JSON object with `root`",
    );
  });

  it('a tool-op executor throw (missing file) surfaces as exit 2, not exit 1 "ran, found nothing" (PI-2)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), "px-pi-host-"));
    const result = await tool.execute(
      "id2",
      { root: "a", nodes: [{ id: "a", commands: [{ tool: "read", path: "does-not-exist.txt" }] }] },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toContain("exit 2");
  });

  it("does not append the batching nudge to an errored tool_result (PI-4)", async () => {
    const event = {
      toolName: "bash",
      isError: true,
      input: { command: "cat foo.txt" },
      content: [{ type: "text", text: "no such file" }],
    };
    const patches = await Promise.all(toolResultHandlers.map((handler) => handler(event)));
    expect(patches.every((patch) => patch === undefined)).toBe(true);
  });

  it("appends the batching nudge to a read-only powershell tool_result (PI-4)", async () => {
    const event = {
      // A shell reader PowerShell also aliases: since Task 9 a cmdlet such as
      // Get-Content is an unknown command head, so it gets no read-only nudge.
      toolName: "powershell",
      isError: false,
      input: { command: "cat foo.txt" },
      content: [{ type: "text", text: "contents" }],
    };
    const patches = await Promise.all(toolResultHandlers.map((handler) => handler(event)));
    const patch = patches.find((p) => p !== undefined) as { content: Array<{ text: string }> } | undefined;
    expect(patch).toBeDefined();
    expect(patch!.content.map((c) => c.text).join("")).toContain("[predexec] Batch read-only commands in one predexec call");
  });
});
