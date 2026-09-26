import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateConditionWithDetail, isSafeRegex, parseConditionString, REGEX_EVAL_TIMEOUT_MS } from "../../core/conditions.ts";
import {
  MAX_JSON_VALUE_DEPTH,
  MAX_JSON_VALUE_NODES,
  MAX_JSON_VALUE_STRING_LENGTH,
} from "../../core/types.ts";
import type { Condition, NodeOutput } from "../../core/types.ts";

const out = (o: Partial<NodeOutput>): NodeOutput => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...o,
});

/** Local thin-wrapper helper standing in for the (removed) core export. */
const evaluateCondition = (output: NodeOutput, cond: Condition, cwd: string): boolean =>
  evaluateConditionWithDetail(output, cond, cwd).result;

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

  it("supports absolute paths inside the session root", () => {
    expect(evaluateCondition(out({}), { kind: "fileExists", path: join(dir, "present.txt") }, dir)).toBe(true);
  });

  it("fileExists refuses paths outside the session root", () => {
    const cwd = dir;
    for (const path of ["../../etc/hosts", "/etc/hosts"]) {
      const r = evaluateConditionWithDetail(out({}), { kind: "fileExists", path }, cwd);
      expect(r.result, path).toBe(false);
      expect(r.detail, path).toContain("outside session root");
      // negate must not turn a refusal into a match
      const negated = evaluateConditionWithDetail(out({}), { kind: "fileExists", path, negate: true }, cwd);
      expect(negated.result, path).toBe(false);
      expect(negated.detail, path).toContain("outside session root");
    }
  });

  it("resolves relative paths against cwd but confines them to the session root", () => {
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    expect(evaluateConditionWithDetail(out({}), { kind: "fileExists", path: "../present.txt" }, sub, dir).result).toBe(true);
    const escaped = evaluateConditionWithDetail(out({}), { kind: "fileExists", path: "../present.txt" }, sub, sub);
    expect(escaped.result).toBe(false);
    expect(escaped.detail).toContain("outside session root");
  });

  it("follows symlinks when checking containment", () => {
    const root = mkdtempSync(join(tmpdir(), "predexec-cond-link-"));
    symlinkSync("/etc", join(root, "etc-link"));
    const r = evaluateConditionWithDetail(out({}), { kind: "fileExists", path: "etc-link/hosts" }, root);
    expect(r.result).toBe(false);
    expect(r.detail).toContain("outside session root");
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

  it("rejects cyclic comparison values without throwing or walking forever", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    const result = evaluateConditionWithDetail(
      out({ stdout: '{"ok":true}' }),
      { kind: "jsonPath", source: "stdout", path: "ok", op: "eq", value },
      "/",
    );
    expect(result.result).toBe(false);
    expect(result.detail).toMatch(/cyclic|budget|invalid/i);
  });

  it("rejects comparison values deeper than the documented boundary", () => {
    const nested = (depth: number): unknown => {
      let value: unknown = true;
      for (let i = 0; i < depth; i++) value = { value };
      return value;
    };
    const atBoundary = evaluateConditionWithDetail(
      out({ stdout: JSON.stringify(nested(MAX_JSON_VALUE_DEPTH)) }),
      { kind: "jsonPath", source: "stdout", path: "$", op: "eq", value: nested(MAX_JSON_VALUE_DEPTH) },
      "/",
    );
    expect(atBoundary.detail).not.toMatch(/depth|budget/i);

    const overBoundary = evaluateConditionWithDetail(
      out({ stdout: '{"ok":true}' }),
      { kind: "jsonPath", source: "stdout", path: "ok", op: "eq", value: nested(MAX_JSON_VALUE_DEPTH + 1) },
      "/",
    );
    expect(overBoundary.result).toBe(false);
    expect(overBoundary.detail).toMatch(/depth|budget/i);
  });

  it("rejects comparison strings one character over the documented boundary", () => {
    const result = evaluateConditionWithDetail(
      out({ stdout: '{"ok":"x"}' }),
      {
        kind: "jsonPath",
        source: "stdout",
        path: "ok",
        op: "eq",
        value: "x".repeat(MAX_JSON_VALUE_STRING_LENGTH + 1),
      },
      "/",
    );
    expect(result.result).toBe(false);
    expect(result.detail).toMatch(/length|budget/i);
  });

  it("rejects comparison values over the node boundary", () => {
    const value = Array.from({ length: MAX_JSON_VALUE_NODES }, () => true);
    const result = evaluateConditionWithDetail(
      out({ stdout: "[true]" }),
      { kind: "jsonPath", source: "stdout", path: "$", op: "eq", value: [...value, true] },
      "/",
    );
    expect(result.result).toBe(false);
    expect(result.detail).toMatch(/node|budget/i);
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

  it.each(["(a|a)+", "(a|aa)+", "(a|a?)+$", "(?:[a-z]|a)+"])(
    "rejects ambiguous quantified alternation %s before RegExp.test",
    (regex) => {
      expect(isSafeRegex(regex)).toBe(false);
      const result = evaluateConditionWithDetail(out({ stdout: "aaaaaaaa" }), {
        kind: "match",
        source: "stdout",
        regex,
      }, "/");
      expect(result.result).toBe(false);
      expect(result.detail).toContain("regex rejected");
    },
  );

  const CATASTROPHIC = [
    "((a+))+$", "(a+b?)+$", "(\\w+\\s?)+$", "(a+){12}$", "((?:a|b)+c?)*$", "(x+x+)+y",
    // zero-width assertions separate nothing
    "(?:(?!b)a+)+$", "(?:\\Ba+)+$", "(?:a+(?!b))+$", "(?:a+\\B)+$", "(?:(?<=a)a+)+$",
    // escapes that do not denote their own letter
    "(?:\\x61a+)+$", "(a)(?:\\1a+)+$", "(?:\\ca+)+$", "(?<x>a)(?:\\k<x>a+)+$", "(?:a+\\x62)+$",
    // bounded-optional repetition (Fibonacci growth)
    "(aa?)+$", "(a?a)+$",
  ];
  const SAFE = ["(?:\\d+\\.)+\\d+", "^v\\d+(?:\\.\\d+){2}$", "(ab)+", "(a|b){3}", "\\w+", "(foo\\s)+bar",
    // beyond the brief: an optional group after an open-ended atom is adjacent only through its first char
    "(\\d+(?:\\.\\d+)?,)+"];
  it.each(CATASTROPHIC)("rejects %s", (p) => expect(isSafeRegex(p)).toBe(false));
  it.each(SAFE)("accepts %s", (p) => expect(isSafeRegex(p)).toBe(true));

  it("every accepted pattern runs in bounded time on adversarial input", () => {
    const gen = ["a", "a?", "b?", "\\w", "\\s?", "a+", "(a+)", "(?:a|b)", "\\d+", "(?!b)", "(?=a)", "\\B", "\\b", "\\x61", "\\1"];
    const input = "a".repeat(28) + "!";
    for (const x of gen) for (const y of gen) for (const q of ["+", "*", "{2,}", "{5}"]) {
      const p = `(${x}${y})${q}$`;
      if (!isSafeRegex(p)) continue;
      const re = new RegExp(p);
      // Minimum of 3 runs: an exponential pattern is slow every time, while a
      // loaded CI box only makes an individual run slow.
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now();
        re.test(input);
        best = Math.min(best, performance.now() - t0);
      }
      expect(best, p).toBeLessThan(50);
    }
  });

  it("bounds execution time for patterns the screen cannot classify", () => {
    // Ungrouped, so isSafeRegex accepts it, but it is O(n^4) on 8192 chars.
    expect(isSafeRegex("a*a*a*a*b")).toBe(true);
    const stdout = "a".repeat(8192);
    for (const cond of [
      { kind: "match", source: "stdout", regex: "a*a*a*a*b" },
      { kind: "match", source: "stdout", regex: "a*a*a*a*b", negate: true },
      { kind: "numeric", source: "stdout", extract: "a*a*a*a*b(\\d+)", op: "eq", value: 1 },
    ] as Condition[]) {
      const t0 = performance.now();
      const r = evaluateConditionWithDetail(out({ stdout }), cond, "/");
      expect(performance.now() - t0).toBeLessThan(1000);
      expect(r.result).toBe(false);
      expect(r.detail).toContain(`exceeded its ${REGEX_EVAL_TIMEOUT_MS}ms time budget`);
    }
  });

  it("still evaluates ordinary regexes after a timeout", () => {
    expect(evaluateCondition(out({ stdout: "ok 42" }), { kind: "match", source: "stdout", regex: "ok \\d+" }, "/")).toBe(true);
    expect(evaluateCondition(out({ stdout: "n=42" }), { kind: "numeric", source: "stdout", extract: "n=(\\d+)", op: "eq", value: 42 }, "/")).toBe(true);
  });

  it("uses preceding-backslash parity when deciding whether a group is escaped", () => {
    expect(isSafeRegex(String.raw`\(`)).toBe(true);
    expect(isSafeRegex(String.raw`\\(a+)+$`)).toBe(false);
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

describe("evaluateConditionWithDetail — observed-value explanations", () => {
  it("does not establish absence or a number from truncated output", () => {
    const incomplete = {
      stdout: "all good\n…[truncated]",
      stderr: "",
      exitCode: 0,
      stdoutTruncated: true,
      stderrTruncated: false,
    };
    expect(evaluateConditionWithDetail(
      incomplete,
      { kind: "match", source: "stdout", regex: "ERROR", negate: true },
      "/",
    )).toMatchObject({ result: false });
    expect(evaluateConditionWithDetail(
      incomplete,
      { kind: "numeric", source: "stdout", extract: "(\\d+)", op: "eq", value: 0 },
      "/",
    )).toMatchObject({ result: false });
  });

  it("allows a positive match observed before truncation", () => {
    const incomplete = {
      stdout: "READY\n…[truncated]",
      stderr: "",
      exitCode: 0,
      stdoutTruncated: true,
      stderrTruncated: false,
    };
    expect(evaluateConditionWithDetail(
      incomplete,
      { kind: "match", source: "stdout", regex: "READY" },
      "/",
    ).result).toBe(true);
  });

  it("does not match synthetic truncation-marker text", () => {
    const incomplete = out({ stdout: "READY\n…[truncated: 20 more chars]", stdoutTruncated: true });
    const result = evaluateConditionWithDetail(
      incomplete,
      { kind: "match", source: "stdout", regex: "truncated" },
      "/",
    );
    expect(result.result).toBe(false);
  });

  it("reports truncated stdout before attempting JSON parsing", () => {
    const incomplete = out({ stdout: '{"ready":true}\n…[truncated]', stdoutTruncated: true });
    const result = evaluateConditionWithDetail(
      incomplete,
      { kind: "jsonPath", source: "stdout", path: "ready", op: "exists" },
      "/",
    );
    expect(result.result).toBe(false);
    expect(result.detail).toContain("stdout was truncated");
    expect(result.detail).not.toContain("not valid JSON");
  });

  it("exitCode states the observed exit", () => {
    const r = evaluateConditionWithDetail(out({ exitCode: 1 }), { kind: "exitCode", op: "eq", value: 0 }, "/");
    expect(r.result).toBe(false);
    expect(r.detail).toBe("exit == 0 → false (exit was 1)");
  });

  it("fileExists states the resolved target and its state", () => {
    const r = evaluateConditionWithDetail(out({}), { kind: "fileExists", path: "nope.txt" }, "/tmp");
    expect(r.result).toBe(false);
    expect(r.detail).toContain("file exists nope.txt → false");
    expect(r.detail).toContain("/tmp/nope.txt is missing");
  });

  it("match states the stream length on a miss and 'matched' on a hit", () => {
    const miss = evaluateConditionWithDetail(
      out({ stdout: "hello world" }),
      { kind: "match", source: "stdout", regex: "ready" },
      "/",
    );
    expect(miss.result).toBe(false);
    expect(miss.detail).toBe("stdout =~ /ready/ → false (no match in 11-char stdout)");

    const hit = evaluateConditionWithDetail(
      out({ stdout: "server ready" }),
      { kind: "match", source: "stdout", regex: "ready" },
      "/",
    );
    expect(hit.result).toBe(true);
    expect(hit.detail).toContain("→ true (matched)");
  });

  it("jsonPath distinguishes bad JSON, missing path, and observed value", () => {
    const badJson = evaluateConditionWithDetail(
      out({ stdout: "not json" }),
      { kind: "jsonPath", source: "stdout", path: "a.b", op: "exists" },
      "/",
    );
    expect(badJson.detail).toContain("stdout is not valid JSON");

    const missing = evaluateConditionWithDetail(
      out({ stdout: '{"a":{}}' }),
      { kind: "jsonPath", source: "stdout", path: "a.b", op: "exists" },
      "/",
    );
    expect(missing.detail).toContain("path not found");

    const value = evaluateConditionWithDetail(
      out({ stdout: '{"scripts":{"test":"vitest"}}' }),
      { kind: "jsonPath", source: "stdout", path: "scripts.test", op: "eq", value: "jest" },
      "/",
    );
    expect(value.result).toBe(false);
    expect(value.detail).toContain('value was "vitest"');
  });

  it("numeric states the extracted number or the extraction failure", () => {
    const extracted = evaluateConditionWithDetail(
      out({ stdout: "3 failing" }),
      { kind: "numeric", source: "stdout", extract: "(\\d+) failing", op: "eq", value: 0 },
      "/",
    );
    expect(extracted.result).toBe(false);
    expect(extracted.detail).toContain("(extracted 3)");

    const nothing = evaluateConditionWithDetail(
      out({ stdout: "all good" }),
      { kind: "numeric", source: "stdout", extract: "(\\d+) failing", op: "eq", value: 0 },
      "/",
    );
    expect(nothing.detail).toContain("regex matched nothing");
  });

  it("unknown kinds and thrown evaluations degrade to explained benign misses", () => {
    const unknown = evaluateConditionWithDetail(out({}), { kind: "vibes" } as any, "/");
    expect(unknown.result).toBe(false);
    expect(unknown.detail).toContain('unknown condition kind "vibes"');

    const badRegex = evaluateConditionWithDetail(
      out({ stdout: "x" }),
      { kind: "match", source: "stdout", regex: "(" },
      "/",
    );
    expect(badRegex.result).toBe(false);
    expect(badRegex.detail).toContain("→ false");
  });
});
