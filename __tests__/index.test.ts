import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// coercePlan is a CORE function; import it from its owning module directly
// rather than through a harness adapter.
import { coercePlan } from "../core/coerce.ts";
import {
  MAX_CONDITION_LENGTH,
  MAX_CONDITION_TOTAL_LENGTH,
  MAX_FIND_RESULTS,
  MAX_GREP_CONTEXT,
  MAX_GREP_RESULTS,
  MAX_GREP_PATTERN_LENGTH,
  MAX_LS_ENTRIES,
  MAX_JSON_VALUE_DEPTH,
  MAX_JSON_VALUE_NODES,
  MAX_JSON_VALUE_STRING_LENGTH,
  MAX_OPERATIONS_PER_NODE,
  MAX_NODE_ID_LENGTH,
  MAX_READ_LINES,
} from "../core/types.ts";
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

  it("rejects an overfull node before validating individual operations", () => {
    const commands = [
      { malformed: true },
      ...Array.from({ length: MAX_OPERATIONS_PER_NODE }, () => "true"),
    ];
    expect(commands).toHaveLength(MAX_OPERATIONS_PER_NODE + 1);
    expect(() => coercePlan({ root: "a", nodes: [{ id: "a", commands }] })).toThrow(
      new RegExp(`maximum of ${MAX_OPERATIONS_PER_NODE} operations`),
    );
  });

  it.each([
    ["read limit", { tool: "read", path: "file.txt", limit: MAX_READ_LINES + 1 }],
    ["grep limit", { tool: "grep", pattern: "x", limit: MAX_GREP_RESULTS + 1 }],
    ["find limit", { tool: "find", pattern: "*.ts", limit: MAX_FIND_RESULTS + 1 }],
    ["ls limit", { tool: "ls", limit: MAX_LS_ENTRIES + 1 }],
    ["grep context", { tool: "grep", pattern: "x", context: MAX_GREP_CONTEXT + 1 }],
  ])("rejects an over-ceiling %s before execution", (_label, operation) => {
    expect(() => coercePlan({ root: "a", nodes: [{ id: "a", commands: [operation] }] })).toThrow(/maximum|at most/);
  });

  it("accepts a grep pattern at the shared ceiling and rejects one character over", () => {
    const exact = { tool: "grep", pattern: "x".repeat(MAX_GREP_PATTERN_LENGTH) };
    expect(() => coercePlan({ root: "a", nodes: [{ id: "a", commands: [exact] }] })).not.toThrow();
    expect(() => coercePlan({ root: "a", nodes: [{ id: "a", commands: [{ ...exact, pattern: `${exact.pattern}x` }] }] })).toThrow(
      new RegExp(`pattern exceeds the maximum length of ${MAX_GREP_PATTERN_LENGTH}`),
    );
  });

  it("bounds direct jsonPath comparison values before condition validation", () => {
    let boundary: unknown = true;
    for (let index = 0; index < MAX_JSON_VALUE_DEPTH; index++) boundary = { value: boundary };
    expect(() => coercePlan({
      root: "a",
      nodes: [{ id: "a", commands: ["true"], edges: [{ when: { kind: "jsonPath", path: "$", op: "eq", value: boundary }, to: "a" }] }],
    })).not.toThrow();

    const tooDeep = { value: boundary };
    expect(() => coercePlan({
      root: "a",
      nodes: [{ id: "a", commands: ["true"], edges: [{ when: { kind: "jsonPath", path: "$", op: "eq", value: tooDeep }, to: "a" }] }],
    })).toThrow(/nesting depth|depth/i);

    expect(() => coercePlan({
      root: "a",
      nodes: [{ id: "a", commands: ["true"], edges: [{ when: { kind: "jsonPath", path: "$", op: "eq", value: "x".repeat(MAX_JSON_VALUE_STRING_LENGTH + 1) }, to: "a" }] }],
    })).toThrow(/maximum length|characters/i);

    const tooManyNodes = Array.from({ length: MAX_JSON_VALUE_NODES }, () => true);
    expect(() => coercePlan({
      root: "a",
      nodes: [{ id: "a", commands: ["true"], edges: [{ when: { kind: "jsonPath", path: "$", op: "eq", value: [...tooManyNodes, true] }, to: "a" }] }],
    })).toThrow(/nodes|maximum/i);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => coercePlan({
      root: "a",
      nodes: [{ id: "a", commands: ["true"], edges: [{ when: { kind: "jsonPath", path: "$", op: "eq", value: cyclic }, to: "a" }] }],
    })).toThrow(/cyclic|cycle/i);
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

  it.each([
    ["match regex", { kind: "match", regex: "x".repeat(MAX_CONDITION_LENGTH) }],
    ["numeric extract", { kind: "numeric", extract: "x".repeat(MAX_CONDITION_LENGTH), op: "eq", value: 0 }],
    ["jsonPath path", { kind: "jsonPath", path: "x".repeat(MAX_CONDITION_LENGTH), op: "exists" }],
    ["fileExists path", { kind: "fileExists", path: "x".repeat(MAX_CONDITION_LENGTH) }],
  ])("accepts the exact condition-string boundary for %s", (_label, when) => {
    expect(() => coercePlan(withWhen(when))).not.toThrow();
  });

  it.each([
    ["match regex", { kind: "match", regex: "x".repeat(MAX_CONDITION_LENGTH + 1) }],
    ["numeric extract", { kind: "numeric", extract: "x".repeat(MAX_CONDITION_LENGTH + 1), op: "eq", value: 0 }],
    ["jsonPath path", { kind: "jsonPath", path: "x".repeat(MAX_CONDITION_LENGTH + 1), op: "exists" }],
    ["fileExists path", { kind: "fileExists", path: "x".repeat(MAX_CONDITION_LENGTH + 1) }],
  ])("rejects condition strings one character over the boundary for %s", (_label, when) => {
    expect(() => coercePlan(withWhen(when))).toThrow(/maximum length.*condition|condition.*maximum length/i);
  });

  it("bounds shorthand conditions before parsing", () => {
    const exact = `stdout =~ /${"x".repeat(MAX_CONDITION_LENGTH - "stdout =~ //".length)}/`;
    expect(exact).toHaveLength(MAX_CONDITION_LENGTH);
    expect(() => coercePlan(withWhen(exact))).not.toThrow();

    const oversized = `stdout =~ /${"x".repeat(MAX_CONDITION_LENGTH)}/`;
    expect(() => coercePlan(withWhen(oversized))).toThrow(/condition.*maximum length/i);
  });

  it("bounds edge targets at the node-id boundary before target lookup", () => {
    const exactTarget = "x".repeat(MAX_NODE_ID_LENGTH);
    expect(() => coercePlan({
      root: "a",
      nodes: [{ id: "a", commands: [], edges: [{ when: "always", to: exactTarget }] }],
    })).not.toThrow();

    const oversizedTarget = "x".repeat(MAX_NODE_ID_LENGTH + 1);
    expect(() => coercePlan({
      root: "a",
      nodes: [{ id: "a", commands: [], edges: [{ when: "always", to: oversizedTarget }] }],
    })).toThrow(/edge target.*maximum length|target.*maximum length/i);
  });

  it("accepts the exact aggregate condition budget and rejects one character over", () => {
    const fixedPerEdge = "fileExists".length + "b".length;
    const fullEdges = Math.floor(MAX_CONDITION_TOTAL_LENGTH / (MAX_CONDITION_LENGTH + fixedPerEdge));
    const usedByFullEdges = fullEdges * (MAX_CONDITION_LENGTH + fixedPerEdge);
    const remainder = MAX_CONDITION_TOTAL_LENGTH - usedByFullEdges - fixedPerEdge;
    const edges = Array.from({ length: fullEdges }, () => ({
      when: { kind: "fileExists", path: "x".repeat(MAX_CONDITION_LENGTH) },
      to: "b",
    }));
    edges.push({ when: { kind: "fileExists", path: "x".repeat(remainder) }, to: "b" });
    expect(() => coercePlan({ root: "a", nodes: [{ id: "a", commands: [], edges }] })).not.toThrow();

    edges[edges.length - 1]!.when.path += "x";
    expect(() => coercePlan({ root: "a", nodes: [{ id: "a", commands: [], edges }] })).toThrow(/condition.*aggregate|aggregate.*condition/i);
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
