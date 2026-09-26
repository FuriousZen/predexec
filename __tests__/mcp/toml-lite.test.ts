import { describe, expect, it } from "vitest";
import { parseTomlLite } from "../../mcp/toml-lite.ts";
import { TOML_LITE_FIXTURES } from "../helpers/toml-fixtures.ts";

// Behavior assertions are driven off the shared fixture table (single source
// of truth with the twin-parity test in __tests__/doctor.test.ts) so a new
// fixture added here automatically extends parity coverage too.
const fixture = (name: string): string => {
  const found = TOML_LITE_FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`no such fixture: ${name}`);
  return found.input;
};

describe("parseTomlLite — realistic config", () => {
  it("parses top-level keys, a dotted mcp_servers table, and quoted-dotted projects tables", () => {
    const result = parseTomlLite(fixture("realistic-config"));
    expect(result).toEqual({
      ok: true,
      value: {
        model: "gpt-5",
        approval_policy: "on-request",
        mcp_servers: {
          predexec: {
            command: "npx",
            args: ["-y", "--package=predexec", "predexec-mcp"],
          },
        },
        projects: {
          "/Users/alice/dev/app": { trust_level: "trusted" },
          "/Users/alice/dev/other": { trust_level: "untrusted" },
        },
      },
    });
  });
});

describe("parseTomlLite — headers", () => {
  it("supports quoted dotted segments in table headers", () => {
    const result = parseTomlLite(fixture("quoted-dotted-header"));
    expect(result).toEqual({ ok: true, value: { a: { "b.c": { d: { x: 1 } } } } });
  });

  it("fails closed on a table reopened by an identical header (TOML forbids it; CX-7)", () => {
    const result = parseTomlLite(fixture("reopened-identical-header"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 4:.*defined more than once/);
  });

  it("merges tables that share a parent prefix", () => {
    expect(parseTomlLite(fixture("shared-prefix-tables-merge"))).toEqual({
      ok: true,
      value: { projects: { "/a": { trust_level: "trusted" }, "/b": { trust_level: "untrusted" } } },
    });
  });
});

describe("parseTomlLite — comments and blank lines", () => {
  it("ignores full-line and trailing comments plus blank lines", () => {
    expect(parseTomlLite(fixture("comments-and-blank-lines"))).toEqual({
      ok: true,
      value: { model: "gpt-5", projects: { "/x": { trust_level: "trusted" } } },
    });
  });

  it("does not treat a # inside a string value as a comment", () => {
    expect(parseTomlLite(fixture("hash-inside-string-is-not-comment"))).toEqual({
      ok: true,
      value: { note: "a # not a comment" },
    });
  });
});

describe("parseTomlLite — escape sequences", () => {
  it("supports \\\" \\\\ \\n \\t in basic strings", () => {
    expect(parseTomlLite(fixture("basic-string-escapes"))).toEqual({ ok: true, value: { key: 'a"b\\c\nd\te' } });
  });

  it("treats literal strings as raw (no escape processing)", () => {
    expect(parseTomlLite(fixture("literal-string-raw"))).toEqual({ ok: true, value: { key: "a\\nb" } });
  });
});

describe("parseTomlLite — value types", () => {
  it("parses booleans, integers, floats, basic and literal strings", () => {
    expect(parseTomlLite(fixture("value-types"))).toEqual({
      ok: true,
      value: { a: true, b: false, c: 42, d: -7, e: 3.14, f: -0.5, g: "basic", h: "literal" },
    });
  });

  it("parses flat arrays of each supported type, single- and multi-line", () => {
    expect(parseTomlLite(fixture("flat-arrays-all-types"))).toEqual({
      ok: true,
      value: {
        strs: ["a", "b", "c"],
        bools: [true, false],
        ints: [1, 2, 3],
        floats: [1.5, -2.5],
        multi: ["x", "y"],
      },
    });
  });

  it("supports bare and quoted keys", () => {
    expect(parseTomlLite(fixture("bare-and-quoted-keys"))).toEqual({
      ok: true,
      value: { bare_key: 1, "quoted key": 2 },
    });
  });
});

describe("parseTomlLite — full TOML constructs Codex writes (CX-1)", () => {
  it("parses inline tables", () => {
    expect(parseTomlLite(fixture("inline-tables"))).toEqual({
      ok: true,
      value: { a: 1, approval_policy: { granular: {} } },
    });
  });

  it("parses arrays of tables", () => {
    expect(parseTomlLite(fixture("array-of-tables-projects"))).toEqual({
      ok: true,
      value: { a: 1, projects: [{ trust_level: "trusted" }] },
    });
  });

  it("parses dotted keys on the left of =", () => {
    expect(parseTomlLite(fixture("dotted-lhs-key"))).toEqual({
      ok: true,
      value: { a: 1, projects: { trust: "trusted" } },
    });
  });

  it("parses nested arrays", () => {
    expect(parseTomlLite(fixture("nested-arrays"))).toEqual({ ok: true, value: { a: [[1, 2], [3, 4]] } });
  });

  it("parses a host-written config: [[skills.config]], inline tables, multi-line strings, dotted keys, unicode, 1_000, 1e5", () => {
    expect(parseTomlLite(fixture("codex-host-written"))).toEqual({
      ok: true,
      value: {
        model: "gpt-5",
        tui: { theme: "dark" },
        note: "café é",
        big: 1000,
        sci: 100000,
        hex: 255,
        blurb: 'multi\nline"',
        raw: "C:\\path",
        shell_environment_policy: { inherit: "core", set: { A: "1" } },
        skills: { config: [{ path: "/s/one", enabled: false }, { path: "/s/two" }] },
        projects: { "/p": { trust_level: "trusted" } },
      },
    });
  });

  it("allows an explicit [a] header after an implicit [a.b] one", () => {
    expect(parseTomlLite(fixture("implicit-then-explicit-table"))).toEqual({
      ok: true,
      value: { a: { b: { x: 1 }, y: 2 } },
    });
  });
});

describe("parseTomlLite — fail closed on anything touching projects / project_root_markers", () => {
  it.each([
    ["malformed-projects-section", /^line 5:/],
    ["malformed-projects-header", /^line 2:/],
    ["malformed-dotted-projects-key", /^line 2:/],
    ["malformed-project-root-markers", /^line \d+:/],
  ])("%s", (name, line) => {
    const result = parseTomlLite(fixture(name));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(line);
  });

  it.each(["array-of-tables-then-table", "table-then-array-of-tables"])(
    "fails closed when [[a]] and [a] define the same name (%s)",
    (name) => {
      const result = parseTomlLite(fixture(name));
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/^line 3:/);
    },
  );

  it("fails closed on a duplicate [a] table header, naming the second one's line (CX-7)", () => {
    const result = parseTomlLite(fixture("duplicate-table-header"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 3:/);
  });
});

describe("parseTomlLite — a parse error outside projects is tolerated as a warning", () => {
  it("a duplicate key in an unrelated table keeps the first value and warns", () => {
    expect(parseTomlLite(fixture("tolerated-duplicate-key"))).toEqual({
      ok: true,
      value: { a: { x: 1, y: 2 } },
      warnings: [expect.stringMatching(/^line 4: duplicate key "x"/)],
    });
  });

  it("an unterminated string drops only that statement", () => {
    expect(parseTomlLite(fixture("tolerated-unterminated-string"))).toEqual({
      ok: true,
      value: { a: 1 },
      warnings: [expect.stringMatching(/^line 2:/)],
    });
  });

  it("string concatenation drops only that statement", () => {
    expect(parseTomlLite(fixture("tolerated-string-concatenation"))).toEqual({
      ok: true,
      value: {},
      warnings: [expect.stringMatching(/^line 1:/)],
    });
  });

  it("a header redefining a scalar discards that table's keys instead of misfiling them", () => {
    expect(parseTomlLite(fixture("tolerated-redefine-scalar-as-table"))).toEqual({
      ok: true,
      value: { a: 1 },
      warnings: [expect.stringMatching(/^line 2:/)],
    });
  });

  it("an error before the projects section still reads the trust entry after it", () => {
    expect(parseTomlLite(fixture("tolerated-error-before-projects"))).toEqual({
      ok: true,
      value: { tui: {}, projects: { "/p": { trust_level: "trusted" } } },
      warnings: [expect.stringMatching(/^line 2:/)],
    });
  });
});

describe("parseTomlLite — fixture table coverage", () => {
  it("has no duplicate fixture names (the parity test in doctor.test.ts assumes uniqueness is not required, but a duplicate name would silently shadow lookups here)", () => {
    const names = TOML_LITE_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
