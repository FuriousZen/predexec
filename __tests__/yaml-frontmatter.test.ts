import { describe, expect, it } from "vitest";
import { parseFrontmatter, parseYamlSubset } from "../yaml-frontmatter.ts";

describe("yaml-frontmatter — the subset opencode v2 agent files use", () => {
  it("splits frontmatter from body; no frontmatter ⇒ empty data", () => {
    expect(parseFrontmatter("---\na: 1\n---\nbody\n")).toEqual({ data: { a: 1 }, body: "body\n" });
    expect(parseFrontmatter("just text")).toEqual({ data: {}, body: "just text" });
    expect(parseFrontmatter("---\n---\nx")).toEqual({ data: {}, body: "x" });
  });

  it("block mappings, quoted keys, comments, scalars", () => {
    expect(
      parseYamlSubset('permission:\n  bash:\n    "cat *": deny # c\n    \'rm *\': ask\n  edit: deny\nhidden: true\nsteps: 3\nt: 0.5\n'),
    ).toEqual({ permission: { bash: { "cat *": "deny", "rm *": "ask" }, edit: "deny" }, hidden: true, steps: 3, t: 0.5 });
  });

  it("block sequences of mappings, indented or at the key's indentation", () => {
    const rules = [{ action: "shell", resource: "cat *", effect: "deny" }];
    expect(parseYamlSubset('permissions:\n  - action: shell\n    resource: "cat *"\n    effect: deny\n')).toEqual({ permissions: rules });
    expect(parseYamlSubset('permissions:\n- action: shell\n  resource: "cat *"\n  effect: deny\n')).toEqual({ permissions: rules });
  });

  it("flow collections", () => {
    expect(parseYamlSubset('permission: {bash: {"cat *": deny, ls: allow}, edit: deny}\nlist: [a, "b c"]')).toEqual({
      permission: { bash: { "cat *": "deny", ls: "allow" }, edit: "deny" },
      list: ["a", "b c"],
    });
  });

  it("block scalars; a quoted top-level value may contain `:`", () => {
    expect(parseYamlSubset("description: |-\n  line one\n  line two\nnext: x")).toEqual({ description: "line one\nline two", next: "x" });
    expect(parseYamlSubset('description: "Reviews code: carefully"')).toEqual({ description: "Reviews code: carefully" });
  });

  it("every mapping is prototype-free (Object.create(null))", () => {
    const out = parseYamlSubset("a: {b: {c: x}}\nd:\n  e: w\nf:\n  - g: z") as Record<string, any>;
    for (const o of [out, out.a, out.a.b, out.d, out.f[0]]) expect(Object.getPrototypeOf(o)).toBe(null);
  });

  it.each([
    ["alias", "permission: *ref"],
    ["anchor", "permission: &a {bash: deny}"],
    ["unclosed flow", "permission: {bash: [x"],
    ["nested a: b: c", "permission:\n  bash: cat: deny"],
    ["duplicate key", "a: 1\na: 2"],
    ["bad indentation", "a:\n    b: 1\n  c: 2"],
    ["multi-document", "a: 1\n---\nb: 2"],
    ["block merge key", "<<: {a: 1}"],
    ["flow merge key", "a: {<<: {b: 1}}"],
    ["line over 4 KiB", `a: ${"x".repeat(5000)}`],
    // R45 — anything outside the unambiguous core throws.
    ["top-level `a: b: c` (v2 sanitize retry)", "description: Reviews code: carefully"],
    ["top-level unquoted colon", "model: a/b:c"],
    ["flow duplicate key", "a: {b: 1, b: 2}"],
    ["nested flow duplicate key", 'permission: {bash: {"x": deny, "x": allow}}'],
    ["__proto__", "__proto__: {a: 1}"],
    ["constructor", "a:\n  constructor: 1"],
    ["prototype (flow)", "a: {prototype: 1}"],
    ["quoted key outside permission", '"a": 1'],
    ["escaped quoted key", 'permission: {"a\\"b": 1}'],
    ["single-quote escape in key", "permission: {'a''b': 1}"],
    ["non-identifier plain key", "permission:\n  git *: allow"],
    ["key with space before colon", "a : 1"],
    ["lone CR", "a: x\rb: y"],
    ["control char", "a: x\x01y"],
    ["tab in value", "a: x\ty"],
    ["unicode line separator", "a: x\u2028y"],
    ["lone surrogate", "a: x\ud800y"],
    ["value starts with -", "a: - x"],
    ["value starts with ?", "a: ? x"],
    ["value starts with ,", "a: , x"],
    ["value starts with ]", "a: ] x"],
    ["value starts with }", "a: } x"],
    ["seq item starts with ?", "a:\n  - ? x"],
    ["flow value starts with -", "a: [- x]"],
    ["flow value with colon", "a: {b: c:d}"],
    ["flow value with #", "a: {b: c#d}"],
    ["flow empty value", "a: {b: }"],
    ["flow empty item", "a: [x, , y]"],
    ["~", "a:\n  b: ~"],
    ["null", "a: null"],
    ["True (non-canonical bool)", "a: True"],
    ["yes", "a: yes"],
    ["off", "a: off"],
    ["y", "a: y"],
    ["octal 010", "a: 010"],
    ["hex", "a: 0x1f"],
    ["underscore int", "a: 1_000"],
    ["sexagesimal", "a:\n  b: 1:30"],
    ["exp float", "a: 1e3"],
    [".inf", "a: .inf"],
    [".nan", "a: .NaN"],
    ["+1", "a: +1"],
    ["timestamp", "a: 2024-01-01"],
    ["float key", "permission:\n  1.0: allow"],
    ["null key", "permission:\n  null: allow"],
    ["bool key", "a: {true: 1}"],
    ["_1 key", "_1: x"],
    ["keep-chomping block scalar", "a: |+\n  x\n"],
    ["comment-looking line inside a block scalar", "a: |-\n  allow\n  # c"],
    ["trailing whitespace inside a block scalar", "a: |-\n  allow  "],
  ])("throws on unsupported/invalid input: %s", (_label, yaml) => {
    expect(() => parseYamlSubset(yaml)).toThrow();
  });

  it.each([
    ["unclosed", "---\na: 1\n"],
    ["language tag", "---yaml\na: 1\n---\n"],
    ["closing ----", "---\na: 1\n----\n"],
    ["closing ---x", "---\na: 1\n---x\n"],
    ["opening with trailing text", "--- a\na: 1\n---\n"],
  ])("strict split throws on shapes gray-matter would still read: %s", (_label, text) => {
    expect(() => parseFrontmatter(text)).toThrow();
  });

  it("the key scan is linear: a 200k-char colon-less line fails fast", () => {
    const t0 = performance.now();
    expect(() => parseYamlSubset(`${"a ".repeat(100_000)}b`)).toThrow();
    expect(() => parseFrontmatter(`---\n${"a ".repeat(100_000)}b\n---\n`)).toThrow();
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
