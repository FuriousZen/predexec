import { describe, expect, it } from "vitest";
import { FrontmatterError, parseFrontmatter, parseYamlSubset } from "../yaml-frontmatter.ts";

describe("yaml-frontmatter — the subset opencode v2 agent files use", () => {
  it("splits frontmatter from body; no frontmatter ⇒ empty data", () => {
    expect(parseFrontmatter("---\na: 1\n---\nbody\n")).toEqual({ data: { a: 1 }, body: "body\n" });
    expect(parseFrontmatter("just text")).toEqual({ data: {}, body: "just text" });
    expect(parseFrontmatter("---\n---\nx")).toEqual({ data: {}, body: "x" });
    expect(parseFrontmatter("---\n# only a comment\n  # another\n---\nx")).toEqual({ data: {}, body: "x" });
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

  it("R46: plain permission keys may carry spaces and glob characters", () => {
    expect(parseYamlSubset("permission:\n  bash:\n    git *: allow\n    rm -rf *: deny")).toEqual({
      permission: { bash: { "git *": "allow", "rm -rf *": "deny" } },
    });
    expect(
      parseYamlSubset("permission:\n  bash:\n    npm run  test ?: ask # c\n  read: {src/**/*.ts: allow, ~/x/*: deny}\n  external_directory:\n    /tmp/**: allow"),
    ).toEqual({
      permission: { bash: { "npm run  test ?": "ask" }, read: { "src/**/*.ts": "allow", "~/x/*": "deny" }, external_directory: { "/tmp/**": "allow" } },
    });
    const out = parseYamlSubset("permission:\n  bash:\n    git *: allow") as Record<string, any>;
    expect(Object.getPrototypeOf(out.permission.bash)).toBe(null);
  });

  it("R46: top-level plain values may contain ':' not followed by a space", () => {
    expect(parseYamlSubset("model: openrouter/x:free\ndescription: see https://x.y/z")).toEqual({
      model: "openrouter/x:free",
      description: "see https://x.y/z",
    });
    // A ` #` still ends a plain value as a comment, exactly as in js-yaml.
    expect(parseYamlSubset("model: openrouter/x:free # c")).toEqual({ model: "openrouter/x:free" });
  });

  it("the first failure carries its line and reason — file lines for parseFrontmatter", () => {
    const fail = (fn: () => unknown): FrontmatterError => {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(FrontmatterError);
        return err as FrontmatterError;
      }
      throw new Error("did not throw");
    };
    const e = fail(() => parseFrontmatter("---\nmode: subagent\ndescription: a: b\n---\nbody\n"));
    expect(e.line).toBe(3);
    expect(e.reason).toContain("mapping value not allowed here");
    expect(fail(() => parseYamlSubset("a: 1\nb:\n  c: x\n  c: y")).line).toBe(4);
    expect(fail(() => parseFrontmatter("---\npermission:\n  bash:\n    git *: allow\n    it's: deny\n---\n")).line).toBe(5);
    expect(fail(() => parseFrontmatter("---\na: |-\n  x\n  # c\n---\n")).line).toBe(4);
    expect(fail(() => parseFrontmatter("---\na: 1\n")).line).toBe(1);
    expect(fail(() => parseFrontmatter("---\na: 1\n----\n")).line).toBe(3);
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
    ["top-level value ending in ':'", "model: a/b:"],
    ["comment-only block with a bare '#' line (gray-matter: null data)", "# c\n   #"],
    ["' #' in a flow plain value", "description: [foo #bar]"],
    ["' #' in a nested flow permission value", "permission: {bash: {git *: allow #x}}"],
    ["flow duplicate key", "a: {b: 1, b: 2}"],
    ["nested flow duplicate key", 'permission: {bash: {"x": deny, "x": allow}}'],
    ["__proto__", "__proto__: {a: 1}"],
    ["constructor", "a:\n  constructor: 1"],
    ["prototype (flow)", "a: {prototype: 1}"],
    ["quoted key outside permission", '"a": 1'],
    ["escaped quoted key", 'permission: {"a\\"b": 1}'],
    ["single-quote escape in key", "permission: {'a''b': 1}"],
    ["non-identifier plain key outside permission", "tools:\n  git *: true"],
    ["top-level key with a space", "a b: 1"],
    ["space before colon in a permission key", "permission:\n  bash:\n    git * : allow"],
    ["permission key with ' #' (comment)", "permission:\n  bash:\n    git #x: allow"],
    ["permission key with '#'", "permission:\n  bash:\n    c#: allow"],
    ["permission key with ':'", "permission:\n  bash:\n    a:b: allow"],
    ["permission key with a quote", "permission:\n  bash:\n    it's: allow"],
    ["permission key with a backslash", "permission:\n  bash:\n    a\\b: allow"],
    ["permission key starting with *", "permission:\n  bash:\n    * rm: allow"],
    ["permission key starting with -", "permission:\n  bash:\n    -rf x: allow"],
    ["permission key starting with !", "permission:\n  bash:\n    !x: allow"],
    ["permission key starting with ?", "permission:\n  bash:\n    ? x: allow"],
    ["permission key starting with &", "permission:\n  bash:\n    &a x: allow"],
    ["permission key starting with [", "permission:\n  bash:\n    [a] x: allow"],
    ["permission merge key", "permission:\n  bash:\n    <<: {a: allow}"],
    ["permission merge key (flow)", "permission: {bash: {<<: {a: allow}}}"],
    ["flow permission key with [", "permission: {bash: {a[b: allow}}"],
    ["flow permission key with {", "permission: {bash: {a{b: allow}}"],
    ["permission key null", "permission:\n  bash:\n    null: allow"],
    ["permission key y", "permission:\n  bash:\n    y: allow"],
    ["permission key number", "permission:\n  bash:\n    10: allow"],
    ["permission key __proto__", "permission:\n  bash:\n    __proto__: allow"],
    ["permission duplicate glob key", "permission:\n  bash:\n    git *: allow\n    git *: deny"],
    ["permission value colon-space", "permission:\n  bash:\n    git *: allow: x"],
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
