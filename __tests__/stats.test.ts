import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { estimateRequestsSaved, recordRun, statsFilePath } from "../stats.ts";
import { statsFilePath as binStatsFilePath } from "../bin/predexec.mjs";
import type { CoreResult, PlanTree } from "../core/index.ts";

const result = (over: Partial<CoreResult> = {}): CoreResult => ({
  transcript: "",
  pathTaken: ["a"],
  depthReached: 0,
  stoppedReason: "leaf",
  fellBack: false,
  terminal: true,
  edgesEvaluated: 0,
  edgesMatched: 0,
  ...over,
});

const plan = (nodes: Array<{ id: string; commands: unknown[] }>): PlanTree =>
  ({ root: nodes[0]!.id, nodes } as unknown as PlanTree);

describe("stats — statsFilePath", () => {
  it("PREDEXEC_STATE_DIR wins over XDG_STATE_HOME", () => {
    const env = { PREDEXEC_STATE_DIR: "/custom", XDG_STATE_HOME: "/xdg" } as NodeJS.ProcessEnv;
    expect(statsFilePath(env)).toBe(join("/custom", "stats.jsonl"));
  });

  it("falls back to XDG_STATE_HOME/predexec, then ~/.local/state/predexec", () => {
    expect(statsFilePath({ XDG_STATE_HOME: "/xdg" } as NodeJS.ProcessEnv)).toBe(
      join("/xdg", "predexec", "stats.jsonl"),
    );
    expect(statsFilePath({} as NodeJS.ProcessEnv)).toContain(join(".local", "state", "predexec", "stats.jsonl"));
  });

  it("bin/predexec.mjs twin resolves identical paths (kept in sync)", () => {
    for (const env of [
      { PREDEXEC_STATE_DIR: "/custom" },
      { XDG_STATE_HOME: "/xdg" },
      {},
    ] as NodeJS.ProcessEnv[]) {
      expect(binStatsFilePath(env)).toBe(statsFilePath(env));
    }
  });
});

describe("stats — estimateRequestsSaved", () => {
  it("counts ops across visited nodes only, minus one", () => {
    const p = plan([
      { id: "a", commands: ["c1", "c2", { tool: "read", path: "x" }] },
      { id: "b", commands: ["c3"] },
      { id: "unvisited", commands: ["c4", "c5"] },
    ]);
    const r = result({ pathTaken: ["a", "b"], depthReached: 1 });
    expect(estimateRequestsSaved(p, r)).toBe(3); // 4 ops visited - 1
  });

  it("single-node depth-0 plan with one command saves nothing", () => {
    expect(estimateRequestsSaved(plan([{ id: "a", commands: ["c1"] }]), result())).toBe(0);
  });

  it("clamps at zero and never throws on malformed plans", () => {
    expect(estimateRequestsSaved(plan([{ id: "a", commands: [] }]), result())).toBe(0);
    expect(estimateRequestsSaved({} as PlanTree, result())).toBe(0);
  });
});

describe("stats — recordRun", () => {
  let dir: string | undefined;
  afterEach(() => {
    delete process.env.PREDEXEC_STATE_DIR;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("appends one valid JSONL record with computed fields", async () => {
    dir = mkdtempSync(join(tmpdir(), "px-stats-"));
    process.env.PREDEXEC_STATE_DIR = dir;
    const p = plan([
      { id: "a", commands: ["c1", "c2"] },
      { id: "b", commands: ["c3"] },
    ]);
    await recordRun(p, result({ pathTaken: ["a", "b"], depthReached: 1, edgesEvaluated: 2, edgesMatched: 1 }), "pi");
    await recordRun(p, result({ pathTaken: ["a"], stoppedReason: "noEdgeMatch", fellBack: true }), "opencode");

    const lines = readFileSync(join(dir, "stats.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({
      v: 1,
      harness: "pi",
      stoppedReason: "leaf",
      depthReached: 1,
      nodes: 2,
      ops: 3,
      edgesEvaluated: 2,
      edgesMatched: 1,
      requestsSaved: 2,
    });
    expect(typeof first.ts).toBe("number");
    const second = JSON.parse(lines[1]!);
    expect(second).toMatchObject({ harness: "opencode", stoppedReason: "noEdgeMatch", nodes: 1, ops: 2, requestsSaved: 1 });
  });

  it("never rejects when the state dir is unwritable", async () => {
    dir = mkdtempSync(join(tmpdir(), "px-stats-"));
    writeFileSync(join(dir, "not-a-dir"), ""); // state dir nested under a FILE → ENOTDIR
    process.env.PREDEXEC_STATE_DIR = join(dir, "not-a-dir", "nested");
    await expect(recordRun(plan([{ id: "a", commands: ["c"] }]), result(), "pi")).resolves.toBeUndefined();
  });
});
