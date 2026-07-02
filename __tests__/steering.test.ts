import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STEERING_LINE,
  STEERING_MARKERS,
  systemHasRoutingInstructions,
} from "../steering.ts";

describe("steering — systemHasRoutingInstructions marker quorum", () => {
  it("returns false for an empty system prompt (opencode should inject)", () => {
    expect(systemHasRoutingInstructions([])).toBe(false);
  });

  it("returns false when no entry mentions predexec", () => {
    expect(systemHasRoutingInstructions(["You are a helpful agent.", "Use bash for reads."])).toBe(false);
  });

  it("a doc that merely MENTIONS predexec scores 1 marker — injection proceeds", () => {
    // The pre-quorum bug: this repo's own CLAUDE.md names the tool constantly
    // and silently disabled steering.
    const system = [
      "You are a helpful agent.",
      "# predexec — project context\npredexec collapses a tool sequence into one round-trip.",
    ];
    expect(systemHasRoutingInstructions(system)).toBe(false);
  });

  it("returns true when a host doc already carries the routing rule (skip injection)", () => {
    const system = ["You are a helpful agent.", "Use predexec for all read-only shell operations."];
    expect(systemHasRoutingInstructions(system)).toBe(true);
  });

  it("detects STEERING_LINE itself (idempotent — no double injection)", () => {
    expect(systemHasRoutingInstructions([STEERING_LINE])).toBe(true);
  });

  it("detects the configs/opencode/AGENTS.md drop-in block", () => {
    const block = readFileSync(join(__dirname, "..", "configs", "opencode", "AGENTS.md"), "utf8");
    expect(systemHasRoutingInstructions([block])).toBe(true);
  });

  it("markers are not substrings of each other", () => {
    for (const a of STEERING_MARKERS) {
      for (const b of STEERING_MARKERS) {
        if (a !== b) expect(a.includes(b)).toBe(false);
      }
    }
  });

  it("single-token markers are word-boundary matched (embedded identifiers don't count)", () => {
    // "mypredexec"/"predexec_v2" must not hit the `predexec` marker; pair each
    // with one real marker so a false hit would reach the quorum.
    expect(systemHasRoutingInstructions(["mypredexec: read-only shell operations"])).toBe(false);
    expect(systemHasRoutingInstructions(["predexec_v2: read-only shell operations"])).toBe(false);
    // A genuine word-boundary mention still counts toward the quorum.
    expect(systemHasRoutingInstructions(["predexec: read-only shell operations"])).toBe(true);
  });

  it("tolerates non-string entries without throwing", () => {
    expect(systemHasRoutingInstructions([null as any, 42 as any, STEERING_LINE])).toBe(true);
    expect(systemHasRoutingInstructions([null as any, 42 as any])).toBe(false);
  });
});
