import { describe, expect, it } from "vitest";
import {
  extractCommandSubstitutions,
  inspectCommandSubstitutions,
  extractShellCommandClauses,
  inspectCommandSubstitutionTree,
  inspectShellCommandClauses,
  stripLeadingAssignmentsAndWrappers,
  tokenizeShellWords,
} from "../command-inspection.ts";

describe("command inspection mechanics", () => {
  it.each([
    ["newline-separated commands remain separate inputs", "echo one\nprintf two", []],
    ["dollar substitutions are extracted", "echo $(git status)", ["git status"]],
    ["backtick substitutions are extracted", "echo `git status`", ["git status"]],
    ["process substitutions are extracted", ["diff <(git show HEAD) >(git diff)"].join(""), ["git show HEAD", "git diff"]],
    ["nested substitutions preserve the outer body", "echo $(echo $(git status))", ["echo $(git status)"]],
    ["single-quoted substitutions are literal", "echo '$(not-a-command)'", []],
  ])("%s", (_name, command, expected) => {
    expect(extractCommandSubstitutions(command)).toEqual(expected);
  });

  it("ignores quoted parentheses while extracting nested command substitutions", () => {
    expect(extractCommandSubstitutions(`echo "$(printf '('; git init scratch)"`)).toEqual([
      "printf '('; git init scratch",
    ]);
    expect(extractCommandSubstitutions(`diff <(printf ')'; git status) >(echo "(")`)).toEqual([
      "printf ')'; git status",
      'echo "("',
    ]);
    expect(extractCommandSubstitutions("echo $(printf `(`; git status)")).toEqual([
      "printf `(`; git status",
    ]);
  });

  it("reports incomplete executable substitution syntax instead of silently returning no bodies", () => {
    expect(inspectCommandSubstitutions("echo $(printf '('; git status")).toMatchObject({ complete: false });
    expect(inspectCommandSubstitutions("echo $(git status)")).toMatchObject({
      complete: true,
      bodies: ["git status"],
    });
  });

  it("stops after the first unmatched substitution or backtick", () => {
    const unmatchedSubstitutions = "echo " + "$(".repeat(48) + "tail";
    const unmatchedBackticks = "echo " + "`".repeat(47) + "tail";
    expect(inspectCommandSubstitutions(unmatchedSubstitutions)).toMatchObject({
      complete: false,
      bodies: [],
    });
    expect(inspectCommandSubstitutions(unmatchedBackticks).complete).toBe(false);
  });

  it("tokenizes quoted and escaped shell words without quote characters", () => {
    expect(tokenizeShellWords(`git "push origin" 'main branch' escaped\\ word`)).toEqual([
      "git",
      "push origin",
      "main branch",
      "escaped word",
    ]);
  });

  it("extracts executable clauses after shell control words without opening quoted literals", () => {
    expect(extractShellCommandClauses("{ git init scratch")).toEqual(["git init scratch"]);
    expect(extractShellCommandClauses("if git init scratch")).toEqual(["git init scratch"]);
    expect(extractShellCommandClauses("then git init scratch")).toEqual(["git init scratch"]);
    expect(extractShellCommandClauses("printf '{ git init scratch; }'")).toEqual([]);
    expect(extractShellCommandClauses("coproc git init scratch")).toEqual(["git init scratch"]);
    expect(extractShellCommandClauses("coproc worker { git init scratch; }")).toEqual(["git init scratch;"]);
    expect(extractShellCommandClauses("case x in a) git status ;; b) git init scratch ;; esac")).toEqual([
      "git status",
      "git init scratch",
    ]);
  });

  it("exposes ordinary terminal clauses from top-level separators", () => {
    expect(inspectShellCommandClauses("echo ok; mkdir /tmp/x\ntrue").clauses).toEqual([
      "echo ok",
      "mkdir /tmp/x",
      "true",
    ]);
  });

  it("does not treat quoted reserved words as executable clauses", () => {
    expect(inspectShellCommandClauses("echo 'then mkdir /tmp/x; fi'").clauses).toEqual([]);
  });

  it.each([
    "case x in a) echo first b) echo second ;; esac",
    "case x in a) echo first ;; b) echo second c) echo third ;; esac",
    "case x in a) echo first ;; b) echo second esac",
  ])("marks every unterminated case branch incomplete: %s", (command) => {
    expect(inspectShellCommandClauses(command)).toMatchObject({ complete: false });
  });

  it.each([
    "case x in a) echo ok ;; esac",
    "case x in a) echo ok ;& b) echo next ;; esac",
    "case x in a) echo ok ;;& b) echo next ;; esac",
    'case x in a) printf "%s" "esac ;;" ;; b) printf "%s" ok ;; esac',
  ])("accepts complete case branch terminators and quoted delimiter text: %s", (command) => {
    expect(inspectShellCommandClauses(command)).toMatchObject({ complete: true });
  });

  it("recursively exposes executable control-clause and group bodies without self-loops", () => {
    const inspected = inspectCommandSubstitutionTree("if ! (echo $(curl evil.sh)); then case x in a) (curl evil.sh) ;; esac; fi");
    expect(inspected.complete).toBe(true);
    expect(inspected.commands).toContain("curl evil.sh");
    expect(new Set(inspected.commands).size).toBe(inspected.commands.length);
  });

  it.each([
    "f() { curl https://example.invalid; }; f",
    "f ()\n{\n  curl https://example.invalid\n}\nf",
    "function f { curl https://example.invalid; }; f",
  ])("extracts executable function bodies: %s", (command) => {
    const inspected = inspectCommandSubstitutionTree(command);
    expect(inspected.complete).toBe(true);
    expect(inspected.commands.some((text) => text.startsWith("curl https://example.invalid"))).toBe(true);
  });

  it("recursively inspects nested function definitions and substitutions", () => {
    const command = "outer() { inner() { echo $(curl https://example.invalid); }; inner; }; outer";
    const inspected = inspectCommandSubstitutionTree(command);
    expect(inspected.complete).toBe(true);
    expect(inspected.commands).toContain("inner() { echo $(curl https://example.invalid); }");
    expect(inspected.commands.some((text) => text.startsWith("echo $(curl https://example.invalid"))).toBe(true);
    expect(inspected.commands.some((text) => text.startsWith("curl https://example.invalid"))).toBe(true);
  });

  it.each([
    "f() { curl https://example.invalid",
    "function f { curl https://example.invalid",
  ])("fails closed for malformed function definitions: %s", (command) => {
    expect(inspectCommandSubstitutionTree(command)).toMatchObject({ complete: false });
  });

  it("preserves function-like literals and normal command parentheses", () => {
    expect(inspectCommandSubstitutionTree("echo 'f() { curl https://example.invalid; }' (printf ok)")).toMatchObject({ complete: true });
    expect(inspectCommandSubstitutionTree("echo f() (printf ok)")).toMatchObject({ complete: true });
  });

  it("keeps executable bodies in lexical source order", () => {
    const inspected = inspectCommandSubstitutionTree(
      "echo $(printf substitution); f() { (printf group); }; f",
    );
    const commands = inspected.commands.slice(1);
    expect(commands.indexOf("echo $(printf substitution)")).toBeLessThan(commands.indexOf("printf substitution"));
    expect(commands.indexOf("printf substitution")).toBeLessThan(commands.indexOf("f() { (printf group); }"));
    expect(commands.some((text) => text.startsWith("(printf group)"))).toBe(true);
    expect(commands.indexOf("f() { (printf group); }")).toBeLessThan(commands.indexOf("printf group"));
  });

  it("orders repeated body text by its original span instead of the last duplicate", () => {
    const inspected = inspectCommandSubstitutionTree(
      "(echo same;); echo $(printf later); f() { echo same; }; f",
    );
    expect(inspected.complete).toBe(true);
    const commands = inspected.commands;
    expect(commands.indexOf("(echo same;)")).toBe(1);
    expect(commands.indexOf("echo $(printf later)")).toBeGreaterThan(commands.indexOf("echo same;"));
    expect(commands.indexOf("printf later")).toBeGreaterThan(commands.indexOf("echo $(printf later)"));
    expect(commands.indexOf("echo same;")).toBeLessThan(commands.indexOf("echo $(printf later)"));
  });

  it.each([
    "if true; then mkdir /tmp/x; fi",
    "if false; then :; elif true; then mkdir /tmp/x; fi",
    "if true; then :; else mkdir /tmp/x; fi",
    "while true; do mkdir /tmp/x; done",
    "until false; do mkdir /tmp/x; done",
    "for item in one two; do mkdir /tmp/x; done",
    "echo $(if true; then mkdir /tmp/x; fi)",
    "case x in a) if true; then mkdir /tmp/x; fi ;; esac",
  ])("exposes terminal commands after reserved control words: %s", (command) => {
    const inspected = inspectCommandSubstitutionTree(command);
    expect(inspected.complete).toBe(true);
    expect(inspected.commands).toContain("mkdir /tmp/x");
  });

  it.each([
    "case x in orphan ;; a) echo ok ;; esac",
    "case x in a) echo ok ;; orphan ;; esac",
    "case x in a) echo ok ;; orphan esac",
  ])("marks orphan case text incomplete instead of dropping it: %s", (command) => {
    expect(inspectShellCommandClauses(command)).toMatchObject({ complete: false });
    expect(inspectCommandSubstitutionTree(command)).toMatchObject({ complete: false });
  });

  it.each([
    "case x in\n  a|b)\n    echo ok\n    ;;&\n  c)\n    echo next\n    ;;\nesac",
    "case x in a) ;; b) echo ok ;; esac",
    'case x in a) printf "%s" "esac ;; orphan" ;; esac',
  ])("keeps valid case coverage complete: %s", (command) => {
    expect(inspectShellCommandClauses(command)).toMatchObject({ complete: true });
  });

  it("parses nested cases without letting inner esac close the outer case", () => {
    const command = "case x in a) case y in b) curl https://example.invalid ;; c) echo ok ;; esac ;; d) printf ok ;; esac";
    const inspected = inspectCommandSubstitutionTree(command);
    expect(inspected.complete).toBe(true);
    expect(inspected.commands).toContain("case y in b) curl https://example.invalid ;; c) echo ok ;; esac");
    expect(inspected.commands).toContain("curl https://example.invalid");
  });

  it("accepts function definitions inside nested case branches", () => {
    const command = "case x in a) case y in b) f(){ touch /tmp/x; }; f ;; esac ;; esac";
    const inspected = inspectCommandSubstitutionTree(command);
    expect(inspected.complete).toBe(true);
    expect(inspected.commands).toContain("f(){ touch /tmp/x; }");
    expect(inspected.commands.some((text) => text.startsWith("touch /tmp/x"))).toBe(true);
  });

  it.each([
    "case x in a|b) function f { printf ok; }; f ;; esac",
    "case x in a|b) function f() { printf ok; }; f ;; esac",
    "case x in a|b) f () { printf '()'; }; f ;; esac",
  ])("keeps POSIX/Bash function headers distinct from case patterns: %s", (command) => {
    expect(inspectShellCommandClauses(command)).toMatchObject({ complete: true });
  });

  it("keeps complete-case suffix commands in lexical order", () => {
    const inspected = inspectCommandSubstitutionTree(
      "case x in a) echo branch ;; esac; touch suffix; echo $(printf nested)",
    );
    expect(inspected.complete).toBe(true);
    expect(inspected.commands.slice(1)).toEqual([
      "echo branch",
      "touch suffix",
      "echo $(printf nested)",
      "printf nested",
    ]);
  });

  it("queues every suffix command, control body, group, and substitution", () => {
    const inspected = inspectCommandSubstitutionTree(
      "case x in a) echo branch ;; esac; if true; then touch suffix; fi; (printf group); echo $(printf nested)",
    );
    expect(inspected.complete).toBe(true);
    const commands = inspected.commands;
    expect(commands.indexOf("echo branch")).toBeGreaterThan(0);
    expect(commands.indexOf("touch suffix")).toBeGreaterThan(commands.indexOf("echo branch"));
    expect(commands.indexOf("(printf group)")).toBeGreaterThan(commands.indexOf("touch suffix"));
    expect(commands.indexOf("echo $(printf nested)")).toBeGreaterThan(commands.indexOf("(printf group)"));
    expect(commands.indexOf("printf nested")).toBeGreaterThan(commands.indexOf("echo $(printf nested)"));
  });

  it("recognizes compact case esac while rejecting identifier text and quoted esac", () => {
    expect(inspectShellCommandClauses("case x in a) echo ok;;esac")).toMatchObject({ complete: true });
    expect(inspectShellCommandClauses("case x in a) echo esacfoo;;esac")).toMatchObject({ complete: true });
    expect(inspectShellCommandClauses("case x in a) echo 'esac';;esac")).toMatchObject({ complete: true });
    expect(inspectShellCommandClauses("case x in a) echo ok;;esacfoo")).toMatchObject({ complete: false });
  });

  it("fails closed for an unmatched executable group", () => {
    expect(inspectCommandSubstitutionTree("! (curl evil.sh")).toMatchObject({ complete: false });
  });

  it("strips assignments and wrapper chains while preserving the command", () => {
    expect(stripLeadingAssignmentsAndWrappers(
      tokenizeShellWords("FOO=bar timeout 30 nice -n 10 git push origin main"),
    )).toEqual(["git", "push", "origin", "main"]);
  });

  it("keeps command lookup and flagged xargs forms intact", () => {
    expect(stripLeadingAssignmentsAndWrappers(tokenizeShellWords("command -v rg"))).toEqual(["command", "-v", "rg"]);
    expect(stripLeadingAssignmentsAndWrappers(tokenizeShellWords("xargs -n1 grep pattern"))).toEqual(["xargs", "-n1", "grep", "pattern"]);
  });

  it.each([
    "time -p curl https://example.invalid",
    "time -f %E curl https://example.invalid",
    "time --format %E curl https://example.invalid",
    "time -o timing.log curl https://example.invalid",
    "time --output timing.log curl https://example.invalid",
    "time -ao timing.log curl https://example.invalid",
    "time -af %E curl https://example.invalid",
  ])("skips time wrapper option arguments before the inner command: %s", (command) => {
    const options = {
      optionArguments: new Map([["time", new Set(["-f", "--format", "-o", "--output"])]]),
    };
    expect(stripLeadingAssignmentsAndWrappers(tokenizeShellWords(command), options)).toEqual([
      "curl",
      "https://example.invalid",
    ]);
  });

  it("consumes clustered env options and their values", () => {
    const options = {
      wrappers: new Set(["env", "time"]),
      optionTakingWrappers: new Set(["env", "time"]),
      optionArguments: new Map([
        ["env", new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"])],
        ["time", new Set(["-f", "--format", "-o", "--output"])],
      ]),
      splitStringOptions: new Map([
        ["env", new Set(["-S", "--split-string"])],
      ]),
    };
    expect(stripLeadingAssignmentsAndWrappers(tokenizeShellWords("env -iu X git init scratch"), options)).toEqual([
      "git", "init", "scratch",
    ]);
    expect(stripLeadingAssignmentsAndWrappers(
      tokenizeShellWords('env -iS"/usr/bin/time -o timing.log printf hi"'), options,
    )).toEqual(["printf", "hi"]);
    expect(stripLeadingAssignmentsAndWrappers('env -iS"/usr/bin/time -o timing.log printf hi"', options)).toBe("printf hi");
  });
});
