import { describe, expect, it } from "vitest";
import { splitCommandSegments } from "../../../core/index.ts";
import { findDestructiveToken, isDestructiveCommand } from "../../../core/destructive.ts";
import {
  effectiveHead,
  lexShellWords,
  stripLeadingAssignmentsAndWrappers,
  tokenizeShellWords,
  WRAPPERS,
} from "../../../core/shell/lexer.ts";

describe("splitCommandSegments", () => {
  // CORE-7: an escaped quote does not open a quoted span, so the `;` after it
  // is a live separator.
  it("honors backslash escapes outside quotes", () => {
    expect(splitCommandSegments('echo \\"; touch X; echo \\"')).toEqual(['echo \\"', "touch X", 'echo \\"']);
  });
});

describe("WRAPPERS", () => {
  it("is the single wrapper vocabulary and includes timeout", () => {
    expect(WRAPPERS.has("timeout")).toBe(true);
  });
});

// Where the merged lexers disagreed, these pin the behavior that was kept.
describe("merged-lexer disagreements", () => {
  it("keeps a backslash before an ordinary character inside double quotes, as the shell does", () => {
    // command-inspection's tokenizer dropped it (`"a\b"` -> `ab`); the shell
    // (and destructive.ts's argv lexer) keeps it.
    expect(tokenizeShellWords('"a\\b" "\\$x" "\\""')).toEqual(["a\\b", "$x", '"']);
  });

  it("keeps a quoted empty string as a word", () => {
    // destructive.ts's argv lexer dropped it, which let `"" cat f` resolve to
    // `cat` and `git "" status` to a read-only verb.
    expect(tokenizeShellWords('git "" status', { atomicSubstitutions: true })).toEqual(["git", "", "status"]);
    expect(effectiveHead('"" cat f')).toBe(null);
    expect(findDestructiveToken('git "" status')).not.toBe(null);
  });

  it("keeps a trailing lone backslash in the word and reports the lex incomplete", () => {
    expect(lexShellWords("echo foo\\")).toMatchObject({ words: [{ value: "echo" }, { value: "foo\\" }], complete: false });
  });

  it("marks words the outer shell expands as dynamic", () => {
    expect(lexShellWords(`a "$x" '$y' \`z\``).words.map((word) => word.dynamic)).toEqual([false, true, false, true]);
  });

  it("keeps a substitution in one argv word only when asked", () => {
    expect(tokenizeShellWords("echo $(a b) c")).toEqual(["echo", "$(a", "b)", "c"]);
    expect(tokenizeShellWords("echo $(a b) c", { atomicSubstitutions: true })).toEqual(["echo", "$(a b)", "c"]);
  });

  it("derives the default stripping vocabulary from core WRAPPERS", () => {
    // command-inspection's own default set had no `env`.
    expect(stripLeadingAssignmentsAndWrappers(tokenizeShellWords("env -u X FOO=1 timeout 5 git push"))).toEqual(["git", "push"]);
    expect(stripLeadingAssignmentsAndWrappers("env -S'nice -n 5 git push'")).toBe("git push");
    expect(stripLeadingAssignmentsAndWrappers(tokenizeShellWords("command -v rg"))).toEqual(["command", "-v", "rg"]);
  });

  it("splits segments on separators after an escaped quote, like the clause splitter", () => {
    expect(splitCommandSegments("echo \\'; rm x; echo \\'")).toEqual(["echo \\'", "rm x", "echo \\'"]);
    expect(splitCommandSegments(String.raw`find . -exec grep x {} \; -print`)).toEqual([String.raw`find . -exec grep x {} \; -print`]);
    expect(isDestructiveCommand('echo \\"; touch X; echo \\"')).toBe(true);
  });
});

describe("assignment grammar (review round 1)", () => {
  it("treats append and subscript assignments as assignments", () => {
    expect(stripLeadingAssignmentsAndWrappers(tokenizeShellWords("X+=1 A[0]=2 B[k]+=3 git push"))).toEqual(["git", "push"]);
    expect(effectiveHead("LESSOPEN+='|x' less f")).toBe("less");
  });

  it("resolves through builtin as a wrapper", () => {
    expect(WRAPPERS.has("builtin")).toBe(true);
    expect(effectiveHead("builtin export X=1")).toBe("export");
  });
});
