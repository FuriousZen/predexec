import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAdapterPlan } from "../adapter-runtime.ts";
import type { Harness } from "../stats.ts";

describe("adapter-runtime — executeAdapterPlan", () => {
  let tempDir: string;
  let statsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "px-ar-test-"));
    statsDir = mkdtempSync(join(tmpdir(), "px-ar-stats-"));
    process.env.PREDEXEC_STATE_DIR = statsDir;
  });

  afterEach(() => {
    delete process.env.PREDEXEC_STATE_DIR;
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(statsDir, { recursive: true, force: true });
  });

  it("runs a valid depth-0 plan end-to-end and records stats", async () => {
    const plan = {
      root: "a",
      nodes: [{ id: "a", commands: ["echo hello-from-adapter-runtime"] }],
    };

    const result = await executeAdapterPlan(plan, "pi", { cwd: tempDir });

    expect(result.stoppedReason).toBe("leaf");
    expect(result.fellBack).toBe(false);
    expect(result.pathTaken).toEqual(["a"]);
    expect(result.depthReached).toBe(0);
    expect(result.transcript).toContain("node a (exit 0)");
    expect(result.transcript).toContain("hello-from-adapter-runtime");

    await vi.waitFor(() => {
      const statsContent = readFileSync(join(statsDir, "stats.jsonl"), "utf8").trim();
      const record = JSON.parse(statsContent);
      expect(record.harness).toBe("pi");
      expect(record.stoppedReason).toBe("leaf");
      expect(record.nodes).toBe(1);
      expect(record.ops).toBe(1);
    });
  });

  it("handles double-encoded input (JSON stringified plan)", async () => {
    const plan = {
      root: "a",
      nodes: [{ id: "a", commands: ["echo stringified-plan"] }],
    };

    const result = await executeAdapterPlan(JSON.stringify(plan), "opencode", { cwd: tempDir });

    expect(result.stoppedReason).toBe("leaf");
    expect(result.pathTaken).toEqual(["a"]);
    expect(result.transcript).toContain("stringified-plan");
  });

  it("handles double-encoded input (stringified nodes array)", async () => {
    const plan = {
      root: "a",
      nodes: JSON.stringify([{ id: "a", commands: ["echo stringified-nodes"] }]),
    };

    const result = await executeAdapterPlan(plan, "claude-code", { cwd: tempDir });

    expect(result.stoppedReason).toBe("leaf");
    expect(result.pathTaken).toEqual(["a"]);
    expect(result.transcript).toContain("stringified-nodes");
  });

  it("recovers from coercion error into stoppedReason: 'error' without throwing", async () => {
    const badPlan = { invalid: true };

    const result = await executeAdapterPlan(badPlan, "pi", { cwd: tempDir });

    expect(result.stoppedReason).toBe("error");
    expect(result.fellBack).toBe(true);
    expect(result.terminal).toBe(false);
    expect(result.pathTaken).toEqual([]);
    expect(result.depthReached).toBe(0);
    expect(result.transcript).toContain("predexec expected a JSON object with `root`");
  });

  it("recovers from engine-level unexpected error into stoppedReason: 'error' without throwing", async () => {
    const plan = {
      root: "a",
      nodes: [{ id: "a", commands: ["echo test"] }],
      cwd: 5 as any, // non-string cwd causes path.resolve to throw inside runPlanTree
    };

    const result = await executeAdapterPlan(plan, "claude-code", { cwd: tempDir });

    expect(result.stoppedReason).toBe("error");
    expect(result.fellBack).toBe(true);
    expect(result.terminal).toBe(false);
    expect(result.pathTaken).toEqual([]);
    expect(result.depthReached).toBe(0);
    expect(result.transcript).toContain("the plan walk failed unexpectedly");
    expect(result.transcript).toContain("Fall back to normal tool calling for this step.");
  });

  it("stats failure remains non-fatal to plan execution", async () => {
    // Break stats directory by pointing it at an unwritable path (file instead of directory)
    const blockerFile = join(tempDir, "blocker");
    writeFileSync(blockerFile, "block");
    process.env.PREDEXEC_STATE_DIR = join(blockerFile, "stats-dir");

    const plan = {
      root: "a",
      nodes: [{ id: "a", commands: ["echo still-works"] }],
    };

    const result = await executeAdapterPlan(plan, "pi", { cwd: tempDir });

    expect(result.stoppedReason).toBe("leaf");
    expect(result.transcript).toContain("still-works");
  });

  describe("contract parity across all harnesses", () => {
    const harnesses: Harness[] = ["pi", "opencode", "claude-code"];

    it.each(harnesses)("returns identical error contract on coercion failure for harness %s", async (harness) => {
      const result = await executeAdapterPlan("{malformed json", harness, { cwd: tempDir });

      expect(result).toMatchObject({
        stoppedReason: "error",
        fellBack: true,
        terminal: false,
        pathTaken: [],
        depthReached: 0,
        edgesEvaluated: 0,
        edgesMatched: 0,
      });
      expect(result.transcript).toContain("could not parse `plan`");
    });

    it.each(harnesses)("returns identical error contract on unexpected engine failure for harness %s", async (harness) => {
      const plan = {
        root: "a",
        nodes: [{ id: "a", commands: ["echo hi"] }],
        cwd: 123 as any,
      };

      const result = await executeAdapterPlan(plan, harness, { cwd: tempDir });

      expect(result).toMatchObject({
        stoppedReason: "error",
        fellBack: true,
        terminal: false,
        pathTaken: [],
        depthReached: 0,
        edgesEvaluated: 0,
        edgesMatched: 0,
      });
      expect(result.transcript).toContain("the plan walk failed unexpectedly");
    });

    it.each(harnesses)("records stats tagged with the respective harness %s", async (harness) => {
      const plan = {
        root: "a",
        nodes: [{ id: "a", commands: ["echo tag-test"] }],
      };

      await executeAdapterPlan(plan, harness, { cwd: tempDir });

      await vi.waitFor(() => {
        const statsContent = readFileSync(join(statsDir, "stats.jsonl"), "utf8").trim();
        const record = JSON.parse(statsContent);
        expect(record.harness).toBe(harness);
      });
    });
  });
});
