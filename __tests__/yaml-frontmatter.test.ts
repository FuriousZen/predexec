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
      parseYamlSubset('permission:\n  bash:\n    "cat *": deny # c\n    \'rm *\': ask\n  edit: deny\nhidden: true\nsteps: 3\nx: ~\n'),
    ).toEqual({ permission: { bash: { "cat *": "deny", "rm *": "ask" }, edit: "deny" }, hidden: true, steps: 3, x: null });
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

  it("block scalars, and gray-matter's top-level `a: b: c` retry as a string", () => {
    expect(parseYamlSubset("description: |-\n  line one\n  line two\nnext: x")).toEqual({ description: "line one\nline two", next: "x" });
    expect(parseYamlSubset("description: Reviews code: carefully")).toEqual({ description: "Reviews code: carefully" });
  });

  it.each([
    ["alias", "permission: *ref"],
    ["anchor", "permission: &a {bash: deny}"],
    ["unclosed flow", "permission: {bash: [x"],
    ["nested a: b: c", "permission:\n  bash: cat: deny"],
    ["duplicate key", "a: 1\na: 2"],
    ["bad indentation", "a:\n    b: 1\n  c: 2"],
    ["multi-document", "a: 1\n---\nb: 2"],
  ])("throws on unsupported/invalid input: %s", (_label, yaml) => {
    expect(() => parseYamlSubset(yaml)).toThrow();
  });
});
