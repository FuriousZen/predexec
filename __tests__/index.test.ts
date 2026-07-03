import { describe, expect, it } from "vitest";
import { coercePlan, mapToolResult } from "../.pi/extension/index.ts";

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

  it("read/ls always exit 0 on success (errors throw and are mapped by the caller)", () => {
    expect(mapToolResult("read", "", undefined).exitCode).toBe(0);
    expect(mapToolResult("ls", "No matches found", undefined).exitCode).toBe(0);
  });
});
