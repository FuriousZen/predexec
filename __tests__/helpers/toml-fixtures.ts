/**
 * Shared fixture table for mcp/toml-lite.ts's parseTomlLite and its plain-JS
 * twin in bin/predexec.mjs.
 *
 * Single source of truth: __tests__/mcp/toml-lite.test.ts imports this array
 * to drive its behavior assertions (specific expected values / error lines),
 * and the twin-parity test in __tests__/doctor.test.ts imports the SAME array
 * to run every case through both implementations. Adding a fixture here
 * automatically extends parity coverage — drift between the two
 * implementations is impossible by construction, rather than by remembering
 * to duplicate a fixture list in two places.
 *
 * Not a `.test.ts` file on purpose, so vitest does not collect it as a suite.
 */

export interface TomlFixture {
  name: string;
  input: string;
}

export const TOML_LITE_FIXTURES: TomlFixture[] = [
  {
    // Modeled on the real ~/.codex/config.toml shape measured in Task 1 /
    // seen on this machine — fixture only, never the real user file.
    name: "realistic-config",
    input: `
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
`,
  },
  {
    name: "quoted-dotted-header",
    input: `[a."b.c".d]\nx = 1\n`,
  },
  {
    name: "reopened-identical-header-merges",
    input: `[mcp_servers.predexec]\ncommand = "npx"\n\n[mcp_servers.predexec]\nargs = ["-y"]\n`,
  },
  {
    name: "shared-prefix-tables-merge",
    input: `[projects."/a"]\ntrust_level = "trusted"\n\n[projects."/b"]\ntrust_level = "untrusted"\n`,
  },
  {
    name: "comments-and-blank-lines",
    input: `# a leading comment\n\nmodel = "gpt-5" # trailing comment\n\n# another\n[projects."/x"]\ntrust_level = "trusted"\n`,
  },
  {
    name: "hash-inside-string-is-not-comment",
    input: 'note = "a # not a comment"\n',
  },
  {
    name: "basic-string-escapes",
    input: 'key = "a\\"b\\\\c\\nd\\te"\n',
  },
  {
    name: "literal-string-raw",
    input: "key = 'a\\nb'\n",
  },
  {
    name: "value-types",
    input: [
      "a = true",
      "b = false",
      "c = 42",
      "d = -7",
      "e = 3.14",
      "f = -0.5",
      'g = "basic"',
      "h = 'literal'",
      "",
    ].join("\n"),
  },
  {
    name: "flat-arrays-all-types",
    input: [
      'strs = ["a", "b", "c"]',
      "bools = [true, false]",
      "ints = [1, 2, 3]",
      "floats = [1.5, -2.5]",
      "multi = [",
      '  "x",',
      '  "y",',
      "]",
      "",
    ].join("\n"),
  },
  {
    name: "bare-and-quoted-keys",
    input: 'bare_key = 1\n"quoted key" = 2\n',
  },
  {
    name: "fail-inline-table",
    input: "a = 1\napproval_policy = { granular = {} }\n",
  },
  {
    name: "fail-array-of-tables",
    input: 'a = 1\n[[projects]]\ntrust_level = "trusted"\n',
  },
  {
    name: "fail-dotted-lhs-key",
    input: 'a = 1\nprojects.trust = "trusted"\n',
  },
  {
    name: "fail-duplicate-key",
    input: "[a]\nx = 1\ny = 2\nx = 3\n",
  },
  {
    name: "fail-unterminated-string",
    input: 'a = 1\nkey = "unterminated\n',
  },
  {
    name: "fail-nested-array",
    input: "a = [[1, 2], [3, 4]]\n",
  },
  {
    name: "fail-string-concatenation",
    input: 'a = "x" "y"\n',
  },
  {
    name: "fail-redefine-scalar-as-table",
    input: "a = 1\n[a]\nb = 2\n",
  },
];
