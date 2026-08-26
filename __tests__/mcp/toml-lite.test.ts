import { describe, expect, it } from "vitest";
import { parseTomlLite } from "../../mcp/toml-lite.ts";

// A realistic ~/.codex/config.toml shape (modeled on the real file measured in
// Task 1 / seen on this machine): top-level keys, an [mcp_servers.predexec]
// block with a command string + args array, and [projects."/abs/path"] tables
// carrying trust_level. Fixture only — never the real user file.
const REALISTIC_CONFIG = `
model = "gpt-5"
approval_policy = "on-request"

# registered via \`codex mcp add\`
[mcp_servers.predexec]
command = "npx"
args = ["-y", "--package=predexec", "predexec-mcp"]

[projects."/Users/alice/dev/app"]
trust_level = "trusted"

[projects."/Users/alice/dev/other"]
trust_level = "untrusted"
`;

describe("parseTomlLite — realistic config", () => {
  it("parses top-level keys, a dotted mcp_servers table, and quoted-dotted projects tables", () => {
    const result = parseTomlLite(REALISTIC_CONFIG);
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
    const result = parseTomlLite(`[a."b.c".d]\nx = 1\n`);
    expect(result).toEqual({ ok: true, value: { a: { "b.c": { d: { x: 1 } } } } });
  });

  it("merges a table reopened by an identical header, adding new keys", () => {
    const text = `[mcp_servers.predexec]\ncommand = "npx"\n\n[mcp_servers.predexec]\nargs = ["-y"]\n`;
    expect(parseTomlLite(text)).toEqual({
      ok: true,
      value: { mcp_servers: { predexec: { command: "npx", args: ["-y"] } } },
    });
  });

  it("merges tables that share a parent prefix", () => {
    const text = `[projects."/a"]\ntrust_level = "trusted"\n\n[projects."/b"]\ntrust_level = "untrusted"\n`;
    expect(parseTomlLite(text)).toEqual({
      ok: true,
      value: { projects: { "/a": { trust_level: "trusted" }, "/b": { trust_level: "untrusted" } } },
    });
  });
});

describe("parseTomlLite — comments and blank lines", () => {
  it("ignores full-line and trailing comments plus blank lines", () => {
    const text = `# a leading comment\n\nmodel = "gpt-5" # trailing comment\n\n# another\n[projects."/x"]\ntrust_level = "trusted"\n`;
    expect(parseTomlLite(text)).toEqual({
      ok: true,
      value: { model: "gpt-5", projects: { "/x": { trust_level: "trusted" } } },
    });
  });

  it("does not treat a # inside a string value as a comment", () => {
    expect(parseTomlLite('note = "a # not a comment"\n')).toEqual({
      ok: true,
      value: { note: "a # not a comment" },
    });
  });
});

describe("parseTomlLite — escape sequences", () => {
  it("supports \\\" \\\\ \\n \\t in basic strings", () => {
    const text = 'key = "a\\"b\\\\c\\nd\\te"\n';
    expect(parseTomlLite(text)).toEqual({ ok: true, value: { key: 'a"b\\c\nd\te' } });
  });

  it("treats literal strings as raw (no escape processing)", () => {
    expect(parseTomlLite("key = 'a\\nb'\n")).toEqual({ ok: true, value: { key: "a\\nb" } });
  });
});

describe("parseTomlLite — value types", () => {
  it("parses booleans, integers, floats, basic and literal strings", () => {
    const text = [
      "a = true",
      "b = false",
      "c = 42",
      "d = -7",
      "e = 3.14",
      "f = -0.5",
      'g = "basic"',
      "h = 'literal'",
      "",
    ].join("\n");
    expect(parseTomlLite(text)).toEqual({
      ok: true,
      value: { a: true, b: false, c: 42, d: -7, e: 3.14, f: -0.5, g: "basic", h: "literal" },
    });
  });

  it("parses flat arrays of each supported type, single- and multi-line", () => {
    const text = [
      'strs = ["a", "b", "c"]',
      "bools = [true, false]",
      "ints = [1, 2, 3]",
      "floats = [1.5, -2.5]",
      "multi = [",
      '  "x",',
      '  "y",',
      "]",
      "",
    ].join("\n");
    expect(parseTomlLite(text)).toEqual({
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
    expect(parseTomlLite('bare_key = 1\n"quoted key" = 2\n')).toEqual({
      ok: true,
      value: { bare_key: 1, "quoted key": 2 },
    });
  });
});

describe("parseTomlLite — explicit failures (fail-closed, loud)", () => {
  it("rejects inline tables, naming the line", () => {
    const result = parseTomlLite('a = 1\napproval_policy = { granular = {} }\n');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 2:/);
  });

  it("rejects array-of-tables, naming the line", () => {
    const result = parseTomlLite('a = 1\n[[projects]]\ntrust_level = "trusted"\n');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 2:/);
  });

  it("rejects dotted keys on the left of =, naming the line", () => {
    const result = parseTomlLite('a = 1\nprojects.trust = "trusted"\n');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 2:/);
  });

  it("rejects a duplicate key within a table, naming the line of the second occurrence", () => {
    const result = parseTomlLite('[a]\nx = 1\ny = 2\nx = 3\n');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 4:/);
  });

  it("rejects an unterminated string, naming the line", () => {
    const result = parseTomlLite('a = 1\nkey = "unterminated\n');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 2:/);
  });

  it("rejects nested arrays, naming the line", () => {
    const result = parseTomlLite("a = [[1, 2], [3, 4]]\n");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 1:/);
  });

  it("rejects string concatenation, naming the line", () => {
    const result = parseTomlLite('a = "x" "y"\n');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 1:/);
  });

  it("rejects a table header trying to redefine a scalar key as a table", () => {
    const result = parseTomlLite('a = 1\n[a]\nb = 2\n');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^line 2:/);
  });
});
