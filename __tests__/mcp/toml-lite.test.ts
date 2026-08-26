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

  it("merges a table reopened by an identical header, adding new keys", () => {
    expect(parseTomlLite(fixture("reopened-identical-header-merges"))).toEqual({
      ok: true,
      value: { mcp_servers: { predexec: { command: "npx", args: ["-y"] } } },
    });
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

describe("parseTomlLite — explicit failures (fail-closed, loud)", () => {
  it("rejects inline tables, naming the line", () => {
    const result = parseTomlLite(fixture("fail-inline-table"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 2:/);
  });

  it("rejects array-of-tables, naming the line", () => {
    const result = parseTomlLite(fixture("fail-array-of-tables"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 2:/);
  });

  it("rejects dotted keys on the left of =, naming the line", () => {
    const result = parseTomlLite(fixture("fail-dotted-lhs-key"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 2:/);
  });

  it("rejects a duplicate key within a table, naming the line of the second occurrence", () => {
    const result = parseTomlLite(fixture("fail-duplicate-key"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 4:/);
  });

  it("rejects an unterminated string, naming the line", () => {
    const result = parseTomlLite(fixture("fail-unterminated-string"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 2:/);
  });

  it("rejects nested arrays, naming the line", () => {
    const result = parseTomlLite(fixture("fail-nested-array"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 1:/);
  });

  it("rejects string concatenation, naming the line", () => {
    const result = parseTomlLite(fixture("fail-string-concatenation"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 1:/);
  });

  it("rejects a table header trying to redefine a scalar key as a table", () => {
    const result = parseTomlLite(fixture("fail-redefine-scalar-as-table"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 2:/);
  });
});

describe("parseTomlLite — fixture table coverage", () => {
  it("has no duplicate fixture names (the parity test in doctor.test.ts assumes uniqueness is not required, but a duplicate name would silently shadow lookups here)", () => {
    const names = TOML_LITE_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
