import { describe, expect, it } from "vitest";
import { compileGitignorePattern, createGitignoreMatcher, gitignorePatternError } from "../../mcp/gitignore-match.ts";

// Semantics per https://git-scm.com/docs/gitignore, which Claude Code's Read
// and Edit rules follow (https://code.claude.com/docs/en/permissions).
describe("createGitignoreMatcher — single patterns", () => {
  const cases: [pattern: string, path: string, isDir: boolean, expected: boolean][] = [
    // A pattern with no slash matches at any depth.
    [".env", ".env", false, true],
    [".env", "config/.env", false, true],
    [".env", "config/.env.local", false, false],
    ["*.env", "a/b/prod.env", false, true],
    // `*` stays inside one segment; `?` is one non-slash char.
    ["src/*.ts", "src/a.ts", false, true],
    ["src/*.ts", "src/x/a.ts", false, false],
    ["?.txt", "a.txt", false, true],
    ["?.txt", "ab.txt", false, false],
    // A middle slash anchors to the base.
    ["a/b", "a/b", false, true],
    ["a/b", "x/a/b", false, false],
    // A leading slash anchors too, and is stripped.
    ["/.env", ".env", false, true],
    ["/.env", "sub/.env", false, false],
    // `**/` leading, `/**` trailing, `/**/` middle.
    ["**/.env", "a/b/.env", false, true],
    ["**/.env", ".env", false, true],
    ["secrets/**", "secrets/x", false, true],
    ["secrets/**", "secrets/a/b", false, true],
    ["secrets/**", "lib/secrets/x", false, false],
    ["a/**/z", "a/z", false, true],
    ["a/**/z", "a/b/c/z", false, true],
    // Character classes, including negated ones, never cross a slash.
    ["[ab].txt", "a.txt", false, true],
    ["[ab].txt", "c.txt", false, false],
    ["[!ab].txt", "c.txt", false, true],
    ["[a-c].txt", "b.txt", false, true],
    // Trailing slash: directories only.
    ["build/", "build", true, true],
    ["build/", "build", false, false],
    // …but a file inside a matched directory is matched through its parent.
    ["build/", "build/out.js", false, true],
    ["secrets", "lib/secrets/key.pem", false, true],
    // Regex metacharacters are literal.
    ["a+b(1).txt", "a+b(1).txt", false, true],
    ["a.b", "axb", false, false],
    // Escapes make a glob char literal.
    ["\\*.txt", "*.txt", false, true],
    ["\\*.txt", "a.txt", false, false],
    // An unclosed class is literal rather than a crash.
    ["[abc", "[abc", false, true],
    // POSIX classes (git wildmatch supports them; verified with
    // `git check-ignore --no-index`).
    ["[[:alpha:]]x", "bx", false, true],
    ["[[:alpha:]]x", "1x", false, false],
    ["[[:digit:]].log", "7.log", false, true],
    ["[![:digit:]].log", "7.log", false, false],
    ["[[:upper:][:digit:]]", "Q", false, true],
    ["[[:space:]]", "a", false, false],
    // Repeated `**` segments collapse, as in git: `a/**/**/b` matches `a/b`.
    ["a/**/**/b", "a/b", false, true],
    ["a/**/**/b", "a/x/y/b", false, true],
    ["**/**/.env", ".env", false, true],
    // A non-segment `**` is a plain `*`.
    ["a**b", "axxb", false, true],
    ["a**b", "ax/b", false, false],
    // `]` first in a class is literal.
    ["[]a]", "]", false, true],
  ];
  it.each(cases)("%s vs %s (dir=%s) → %s", (pattern, path, isDir, expected) => {
    expect(createGitignoreMatcher([pattern])(path, isDir)).toBe(expected);
  });

  it("never matches the base itself or an empty path", () => {
    expect(createGitignoreMatcher(["**"])("", true)).toBe(false);
  });
});

describe("createGitignoreMatcher — ordered negation", () => {
  it("a later `!` carves a path back out", () => {
    const m = createGitignoreMatcher(["*.env", "!sample.env"]);
    expect(m("prod.env", false)).toBe(true);
    expect(m("a/sample.env", false)).toBe(false);
  });

  it("a `!` listed first carves nothing out", () => {
    const m = createGitignoreMatcher(["!sample.env", "*.env"]);
    expect(m("sample.env", false)).toBe(true);
  });

  it("the last matching pattern wins, so a re-exclusion after a carve-out holds", () => {
    const m = createGitignoreMatcher(["*.env", "!sample.env", "sample.env"]);
    expect(m("sample.env", false)).toBe(true);
  });

  it("cannot re-include a file whose parent directory is excluded", () => {
    const m = createGitignoreMatcher(["secrets/**", "!secrets/public/**"]);
    expect(m("secrets/public/x", false)).toBe(true);
    expect(m("secrets/public", true)).toBe(true);
  });

  it("`\\!` is a literal bang, not a negation", () => {
    const m = createGitignoreMatcher(["\\!important"]);
    expect(m("!important", false)).toBe(true);
  });
});

describe("compileGitignorePattern", () => {
  it("reports negation, directory-only and anchoring", () => {
    expect(compileGitignorePattern("!/build/")).toMatchObject({ negated: true, dirOnly: true, anchored: true });
    expect(compileGitignorePattern(".env")).toMatchObject({ negated: false, dirOnly: false, anchored: false });
  });

  it("ignores blank and comment lines", () => {
    expect(compileGitignorePattern("")).toBeNull();
    expect(compileGitignorePattern("# note")).toBeNull();
  });
});

describe("gitignore matcher — termination (patterns come from settings, paths from the model)", () => {
  // Each of these took 16-65 s with a backtracking-regex compilation.
  const timed = (fn: () => boolean) => {
    const start = performance.now();
    const value = fn();
    return { value, ms: performance.now() - start };
  };

  it("`*a*a*a*a*b` vs a 255-char name", () => {
    const { value, ms } = timed(() => createGitignoreMatcher(["*a*a*a*a*b"])("a".repeat(255), false));
    expect(value).toBe(false);
    expect(ms).toBeLessThan(50);
  });

  it("`*a*a*a*a*a*a*a*a*b` vs a 60-char name", () => {
    const { value, ms } = timed(() => createGitignoreMatcher(["*a*a*a*a*a*a*a*a*b"])("a".repeat(60), false));
    expect(value).toBe(false);
    expect(ms).toBeLessThan(50);
    expect(createGitignoreMatcher(["*a*a*a*a*a*a*a*a*b"])(`${"a".repeat(60)}b`, false)).toBe(true);
  });

  it("`**/a/**/a/**/a/**/b` vs a 300-segment path", () => {
    const path = Array(300).fill("a").join("/");
    const { value, ms } = timed(() => createGitignoreMatcher(["**/a/**/a/**/a/**/b"])(path, false));
    expect(value).toBe(false);
    expect(ms).toBeLessThan(50);
    expect(createGitignoreMatcher(["**/a/**/a/**/a/**/b"])(`${path}/b`, false)).toBe(true);
  });
});

describe("gitignorePatternError — invalid patterns are reported, never thrown", () => {
  it("flags a reversed range and an unknown POSIX class", () => {
    expect(gitignorePatternError("[z-a].env")).toMatch(/range/);
    expect(gitignorePatternError("[[:nope:]]")).toMatch(/class/);
    expect(gitignorePatternError(".env")).toBeNull();
    expect(() => createGitignoreMatcher(["[z-a].env"])("b.env", false)).not.toThrow();
  });
});
