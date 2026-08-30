import { describe, expect, it } from "vitest";
import {
  extractCommandSubstitutions,
  extractShellCommandClauses,
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
