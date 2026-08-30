import { describe, expect, it } from "vitest";
import {
  extractCommandSubstitutions,
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
});
