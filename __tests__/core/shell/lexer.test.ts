import { describe, expect, it } from "vitest";
import { splitCommandSegments } from "../../../core/index.ts";
import { findDestructiveToken, isDestructiveCommand } from "../../../core/destructive.ts";
import {
  effectiveHead,
  lexShellWords,
  maskHeredocBodies,
  commandStdin,
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

describe("here-strings and heredoc stdin literals", () => {
  it("never reads a here-string's `<<` as a heredoc", () => {
    expect(maskHeredocBodies("cat <<< 'E'\nrm -rf x\nE")).toBe("cat <<< 'E'\nrm -rf x\nE");
  });

  it("pairs each stdin literal with its owning simple command", () => {
    const heredoc = commandStdin("ls; x=$(python3 - <<'EOF'\nprint(1)\nEOF\n)").find((c) => c.literals.length > 0);
    expect(heredoc?.command.trim()).toBe("python3 -");
    expect(heredoc?.literals).toEqual([{ kind: "heredoc", text: "print(1)\n" }]);
    const hereString = commandStdin("case a in a) node <<< 'console.log(1)' 2>&1;; esac").find((c) => c.literals.length > 0);
    expect(hereString?.command.trim()).toBe("node");
    expect(hereString?.literals).toEqual([{ kind: "here-string", text: "console.log(1)" }]);
  });

  it("leaves other fds out, flags file stdin and marks expanded text unknowable", () => {
    const literals = (c: string) => commandStdin(c).flatMap((s) => s.literals.map((l) => l.text));
    expect(literals("python3 3<<< x")).toEqual([]);
    expect(literals("python3 <<< \"$x\"")).toEqual([null]);
    expect(literals("python3 <<E\n$(cat f)\nE")).toEqual([null]);
    expect(literals("python3 <<'E'OF\nx\nE\nEOF")).toEqual([null]);
    expect(commandStdin("python3 < f 2>/dev/null").map((c) => [c.command.trim(), c.redirected])).toEqual([["python3", true]]);
  });

  it("does not open a heredoc at an arithmetic shift", () => {
    expect(maskHeredocBodies("echo $((1<<2))\nrm x\n2")).toBe("echo $((1<<2))\nrm x\n2");
    expect(maskHeredocBodies("(( y = 1<<2 ))\nrm x\n2")).toBe("(( y = 1<<2 ))\nrm x\n2");
    expect(maskHeredocBodies("echo $((1<<2)); cat <<EOF\nrm x\nEOF")).toBe("echo $((1<<2)); cat <<EOF\n    \n   ");
    expect(maskHeredocBodies("ls # <<x\nrm y\nx")).toBe("ls # <<x\nrm y\nx");
    expect(maskHeredocBodies("echo `cat <<x`\nrm y\nx")).toBe("echo `cat <<x`\nrm y\nx");
    expect(maskHeredocBodies("echo $(cat <<x\nrm y\nx\n)")).toBe("echo $(cat <<x\n    \n \n)");
    expect(maskHeredocBodies("echo \"$(( \" <<x \" ))\"\nrm y\nx")).toBe("echo \"$(( \" <<x \" ))\"\nrm y\nx");
  });
});
