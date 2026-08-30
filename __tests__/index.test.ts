import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// coercePlan is a CORE function; import it from its owning module directly
// rather than through a harness adapter.
import { coercePlan } from "../core/coerce.ts";
import { mapToolResult } from "../.pi/extension/index.ts";
import { JSON_PATH_SINGLE_OP_LINE, STEERING_MARKERS } from "../steering.ts";


describe("coercePlan — defensive param recovery", () => {
  const good = { root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] };

  it("passes a well-formed object through unchanged", () => {
    expect(coercePlan(good)).toEqual(good);
  });

  it("parses a fully stringified plan", () => {
    expect(coercePlan(JSON.stringify(good))).toEqual(good);
  });

  it("parses a stringified `nodes` array (the mimo double-encode case)", () => {
    const plan = coercePlan({ root: "a", nodes: JSON.stringify(good.nodes) });
    expect(plan.nodes).toEqual(good.nodes);
    expect(plan.root).toBe("a");
  });

  it("throws a readable error on malformed JSON", () => {
    expect(() => coercePlan("{not json")).toThrow(/could not parse `plan`/);
  });

  it("throws a shape error (not a validator dump) when root/nodes are missing", () => {
    expect(() => coercePlan({ foo: 1 })).toThrow(/`root`.*`nodes`/);
  });

  it("rejects an oversized shell command before condition parsing", () => {
    expect(() => coercePlan({
      root: "a",
      nodes: [{ id: "a", commands: ["echo " + "x".repeat(70_000)], edges: [{ when: "not a valid condition", to: "b" }] }, { id: "b", commands: [] }],
    })).toThrow(/command.*maximum|too long/i);
  });

  it("rejects an oversized plan before walking or parsing its nodes", () => {
    const nodes = Array.from({ length: 300 }, (_, index) => ({ id: `n${index}`, commands: [] }));
    expect(() => coercePlan({ root: "n0", nodes })).toThrow(/nodes.*maximum|too many/i);
  });

  it("coerces string edge conditions into objects", () => {
    const plan = coercePlan({
      root: "a",
      nodes: [{
        id: "a",
        commands: ["echo hi"],
        edges: [{ when: "exit == 0", to: "b" }],
      }, {
        id: "b",
        commands: ["echo done"],
      }],
    });
    expect(plan.nodes[0]!.edges![0]!.when).toEqual({ kind: "exitCode", op: "eq", value: 0 });
  });

  it("throws a readable error on unparseable condition string", () => {
    expect(() => coercePlan({
      root: "a",
      nodes: [{ id: "a", commands: ["echo"], edges: [{ when: "gibberish", to: "b" }] }],
    })).toThrow(/could not parse condition string "gibberish"/);
  });

  it("leaves object conditions untouched", () => {
    const cond = { kind: "exitCode", op: "eq", value: 0 };
    const plan = coercePlan({
      root: "a",
      nodes: [{ id: "a", commands: ["echo"], edges: [{ when: cond, to: "b" }] }, { id: "b", commands: ["echo"] }],
    });
    expect(plan.nodes[0]!.edges![0]!.when).toEqual(cond);
  });
});

describe("coercePlan — object-condition validation (loud, not silent-false)", () => {
  const withWhen = (when: unknown) => ({
    root: "a",
    nodes: [{ id: "a", commands: ["echo"], edges: [{ when, to: "b" }] }, { id: "b", commands: ["echo"] }],
  });

  it("rejects an unknown kind, listing the valid ones", () => {
    expect(() => coercePlan(withWhen({ kind: "vibes" }))).toThrow(/unknown condition kind "vibes".*exitCode/);
  });

  it("rejects exitCode without op/value", () => {
    expect(() => coercePlan(withWhen({ kind: "exitCode" }))).toThrow(/exitCode requires op/);
    expect(() => coercePlan(withWhen({ kind: "exitCode", op: "eq", value: "0" }))).toThrow(/numeric value/);
  });

  it("rejects fileExists without a path", () => {
    expect(() => coercePlan(withWhen({ kind: "fileExists" }))).toThrow(/fileExists requires a string path/);
  });

  it("rejects match with a non-compiling regex", () => {
    expect(() => coercePlan(withWhen({ kind: "match", source: "stdout", regex: "(" }))).toThrow(/compiles/);
  });

  it("rejects numeric without a valid extract regex", () => {
    expect(() => coercePlan(withWhen({ kind: "numeric", op: "eq", value: 0 }))).toThrow(/extract/);
  });

  it("fills a missing source instead of rejecting (evaluator defaults to stdout)", () => {
    const plan = coercePlan(withWhen({ kind: "match", regex: "ok" }));
    expect(plan.nodes[0]!.edges![0]!.when).toEqual({ kind: "match", regex: "ok", source: "stdout" });
  });

  it("rejects a non-string non-object when", () => {
    expect(() => coercePlan(withWhen(42))).toThrow(/number `when`/);
  });

  it("tolerates extra fields on a valid condition (pi's loose schema)", () => {
    expect(() =>
      coercePlan(withWhen({ kind: "exitCode", op: "eq", value: 0, comment: "extra" })),
    ).not.toThrow();
  });
});

describe("mapToolResult — pi/opencode exit-code parity", () => {
  it("grep with zero matches (pi sentinel, no details) => exit 1", () => {
    expect(mapToolResult("grep", "No matches found", undefined).exitCode).toBe(1);
  });

  it("find with zero results (pi sentinel, no details) => exit 1", () => {
    expect(mapToolResult("find", "No files found matching pattern", undefined).exitCode).toBe(1);
  });

  it("grep with real matches => exit 0 even when details are absent", () => {
    expect(mapToolResult("grep", "src/a.ts:5:const x = 1", undefined).exitCode).toBe(0);
  });

  it("sentinel-looking CONTENT with details present is a real result => exit 0", () => {
    // A file whose text happens to contain the sentinel: pi attaches details on
    // real matches, so this must not be misread as zero results.
    expect(mapToolResult("grep", "No matches found", { matchLimitReached: 5 }).exitCode).toBe(0);
  });

  it("marks pi tool results incomplete when the host reports a semantic limit", () => {
    expect(mapToolResult("read", "line\n[Showing lines 1-1 of 2]", { truncation: { truncated: true } }).stdoutTruncated).toBe(true);
    expect(mapToolResult("grep", "hit", { matchLimitReached: 10 }).stdoutTruncated).toBe(true);
  });

  it("read/ls always exit 0 on success (errors throw and are mapped by the caller)", () => {
    expect(mapToolResult("read", "", undefined).exitCode).toBe(0);
    expect(mapToolResult("ls", "No matches found", undefined).exitCode).toBe(0);
  });
});

describe("configs/*/AGENTS.md drop-ins — STEERING_MARKERS quorum", () => {
  // Each host's drop-in block must carry ≥2 of the 3 STEERING_MARKERS (see
  // steering.ts) so a host that loads it natively (opencode's system-prompt
  // guard, Codex's native AGENTS.md loading) recognizes routing rules are
  // already present and skips its own injection. steering.test.ts already
  // covers opencode's file through systemHasRoutingInstructions; this test
  // asserts the raw marker count directly (per the task brief) and does so
  // for both drop-ins side by side so the two files stay in lockstep.
  const quorumHits = (text: string): number =>
    STEERING_MARKERS.filter((marker) =>
      marker.includes(" ")
        ? text.includes(marker)
        : new RegExp(`(?:^|\\W)${marker}(?:\\W|$)`).test(text),
    ).length;

  it.each([
    ["opencode", join(__dirname, "..", "configs", "opencode", "AGENTS.md")],
    ["codex", join(__dirname, "..", "configs", "codex", "AGENTS.md")],
  ])("%s's AGENTS.md carries at least 2 of the 3 STEERING_MARKERS", (_host, path) => {
    const block = readFileSync(path, "utf8");
    expect(quorumHits(block)).toBeGreaterThanOrEqual(2);
  });
});

describe("adapter plan authoring guidance", () => {
  it("teaches the single-operation jsonPath rule in every adapter", () => {
    for (const path of [
      join(__dirname, "..", ".pi", "extension", "index.ts"),
      join(__dirname, "..", "mcp", "server.ts"),
      join(__dirname, "..", ".opencode", "plugins", "predexec.ts"),
    ]) {
      expect(readFileSync(path, "utf8"), path).toContain("JSON_PATH_SINGLE_OP_LINE");
    }
    expect(JSON_PATH_SINGLE_OP_LINE).toBe("jsonPath edges require a one-operation source node.");
  });
});
