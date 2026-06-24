import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateCondition, parseConditionString } from "../../core/conditions.ts";
import type { NodeOutput } from "../../core/types.ts";

const out = (o: Partial<NodeOutput>): NodeOutput => ({ stdout: "", stderr: "", exitCode: 0, ...o });

describe("evaluateCondition — exitCode", () => {
  it("compares with eq/ne/lt/gt", () => {
    expect(evaluateCondition(out({ exitCode: 0 }), { kind: "exitCode", op: "eq", value: 0 }, "/")).toBe(true);
    expect(evaluateCondition(out({ exitCode: 1 }), { kind: "exitCode", op: "eq", value: 0 }, "/")).toBe(false);
    expect(evaluateCondition(out({ exitCode: 2 }), { kind: "exitCode", op: "ne", value: 0 }, "/")).toBe(true);
    expect(evaluateCondition(out({ exitCode: 1 }), { kind: "exitCode", op: "lt", value: 2 }, "/")).toBe(true);
    expect(evaluateCondition(out({ exitCode: 3 }), { kind: "exitCode", op: "gt", value: 2 }, "/")).toBe(true);
  });
});

describe("evaluateCondition — fileExists", () => {
  const dir = mkdtempSync(join(tmpdir(), "predexec-cond-"));
  writeFileSync(join(dir, "present.txt"), "x");

  it("detects presence relative to cwd and honors negate", () => {
    expect(evaluateCondition(out({}), { kind: "fileExists", path: "present.txt" }, dir)).toBe(true);
    expect(evaluateCondition(out({}), { kind: "fileExists", path: "absent.txt" }, dir)).toBe(false);
    expect(evaluateCondition(out({}), { kind: "fileExists", path: "absent.txt", negate: true }, dir)).toBe(true);
  });

  it("supports absolute paths", () => {
    expect(evaluateCondition(out({}), { kind: "fileExists", path: join(dir, "present.txt") }, "/nowhere")).toBe(true);
  });
});

describe("evaluateCondition — jsonPath", () => {
  const json = JSON.stringify({ scripts: { test: "vitest" }, items: [{ id: 1 }, { id: 2 }] });

  it("resolves dot/bracket paths and compares", () => {
    expect(evaluateCondition(out({ stdout: json }), { kind: "jsonPath", source: "stdout", path: "scripts.test", op: "exists" }, "/")).toBe(true);
    expect(evaluateCondition(out({ stdout: json }), { kind: "jsonPath", source: "stdout", path: "scripts.test", op: "eq", value: "vitest" }, "/")).toBe(true);
    expect(evaluateCondition(out({ stdout: json }), { kind: "jsonPath", source: "stdout", path: "items[1].id", op: "eq", value: 2 }, "/")).toBe(true);
    expect(evaluateCondition(out({ stdout: json }), { kind: "jsonPath", source: "stdout", path: "scripts.build", op: "exists" }, "/")).toBe(false);
    expect(evaluateCondition(out({ stdout: json }), { kind: "jsonPath", source: "stdout", path: "scripts.test", op: "ne", value: "jest" }, "/")).toBe(true);
  });

  it("returns false on unparseable JSON (benign miss, no throw)", () => {
    expect(evaluateCondition(out({ stdout: "not json" }), { kind: "jsonPath", source: "stdout", path: "a", op: "exists" }, "/")).toBe(false);
  });
});

describe("evaluateCondition — numeric", () => {
  it("extracts a number and compares", () => {
    expect(evaluateCondition(out({ stdout: "coverage: 87%" }), { kind: "numeric", source: "stdout", extract: "(\\d+)%", op: "ge", value: 80 }, "/")).toBe(true);
    expect(evaluateCondition(out({ stdout: "coverage: 72%" }), { kind: "numeric", source: "stdout", extract: "(\\d+)%", op: "ge", value: 80 }, "/")).toBe(false);
  });

  it("returns false when the regex does not match", () => {
    expect(evaluateCondition(out({ stdout: "no number here" }), { kind: "numeric", source: "stdout", extract: "(\\d+)", op: "eq", value: 1 }, "/")).toBe(false);
  });
});

describe("evaluateCondition — match (low confidence)", () => {
  it("tests regex on the chosen stream and honors negate", () => {
    expect(evaluateCondition(out({ stderr: "error: boom" }), { kind: "match", source: "stderr", regex: "error" }, "/")).toBe(true);
    expect(evaluateCondition(out({ stdout: "all good" }), { kind: "match", source: "stdout", regex: "error" }, "/")).toBe(false);
    expect(evaluateCondition(out({ stdout: "all good" }), { kind: "match", source: "stdout", regex: "error", negate: true }, "/")).toBe(true);
  });

  it("returns false on an invalid regex instead of throwing", () => {
    expect(evaluateCondition(out({ stdout: "x" }), { kind: "match", source: "stdout", regex: "(" }, "/")).toBe(false);
  });
});

describe("evaluateCondition — always", () => {
  it("is unconditionally true", () => {
    expect(evaluateCondition(out({ exitCode: 5 }), { kind: "always" }, "/")).toBe(true);
  });
});

describe("parseConditionString", () => {
  it("parses 'always'", () => {
    expect(parseConditionString("always")).toEqual({ kind: "always" });
  });

  it("parses exit code conditions", () => {
    expect(parseConditionString("exit == 0")).toEqual({ kind: "exitCode", op: "eq", value: 0 });
    expect(parseConditionString("exit != 0")).toEqual({ kind: "exitCode", op: "ne", value: 0 });
    expect(parseConditionString("exit > 1")).toEqual({ kind: "exitCode", op: "gt", value: 1 });
    expect(parseConditionString("exit < 5")).toEqual({ kind: "exitCode", op: "lt", value: 5 });
  });

  it("parses match conditions", () => {
    expect(parseConditionString("stdout =~ /error/")).toEqual({ kind: "match", source: "stdout", regex: "error" });
    expect(parseConditionString("stderr =~ /warn/")).toEqual({ kind: "match", source: "stderr", regex: "warn" });
    expect(parseConditionString("stdout !~ /ok/")).toEqual({ kind: "match", source: "stdout", regex: "ok", negate: true });
  });

  it("parses file conditions", () => {
    expect(parseConditionString("file exists src/main.ts")).toEqual({ kind: "fileExists", path: "src/main.ts" });
    expect(parseConditionString("file missing .env")).toEqual({ kind: "fileExists", path: ".env", negate: true });
  });

  it("returns null for unrecognized syntax", () => {
    expect(parseConditionString("something weird")).toBeNull();
    expect(parseConditionString("")).toBeNull();
    expect(parseConditionString("exit === 0")).toBeNull();
  });

  it("handles whitespace", () => {
    expect(parseConditionString("  always  ")).toEqual({ kind: "always" });
    expect(parseConditionString("exit  ==  0")).toEqual({ kind: "exitCode", op: "eq", value: 0 });
  });
});
