import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexPolicyChecker, readCodexRules } from "../../mcp/policy-codex.ts";
import { runPlanTree } from "../../core/engine.ts";
import type { PlanTree } from "../../core/types.ts";

let tmp: string;
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

/** A fresh `<tmp>/codexHome` + `<tmp>/project` pair, isolated from the real machine. */
function setup() {
  tmp = mkdtempSync(join(tmpdir(), "px-codex-policy-"));
  const codexHome = join(tmp, "home", ".codex");
  const projectDir = join(tmp, "project");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  return { codexHome, projectDir };
}

const writeRule = (dir: string, name: string, body: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
};

const trustConfig = (projectDir: string, trusted: boolean) =>
  `[projects."${projectDir}"]\ntrust_level = "${trusted ? "trusted" : "untrusted"}"\n`;

describe("readCodexRules — discovery", () => {
  it("always reads <codexHome>/rules/*.rules", () => {
    const { codexHome, projectDir } = setup();
    writeRule(join(codexHome, "rules"), "default.rules", 'prefix_rule(pattern=["git","push"], decision="forbidden")\n');
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([{ pattern: ["git", "push"], decision: "forbidden" }]);
  });

  it("reads <projectDir>/.codex/rules ONLY when config.toml marks the project trusted", () => {
    const { codexHome, projectDir } = setup();
    writeFileSync(join(codexHome, "config.toml"), trustConfig(projectDir, true));
    writeRule(
      join(projectDir, ".codex", "rules"),
      "project.rules",
      'prefix_rule(pattern=["rm","-rf"], decision="forbidden")\n',
    );
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([{ pattern: ["rm", "-rf"], decision: "forbidden" }]);
  });

  it("ignores an untrusted project's .codex/rules entirely", () => {
    const { codexHome, projectDir } = setup();
    writeFileSync(join(codexHome, "config.toml"), trustConfig(projectDir, false));
    writeRule(
      join(projectDir, ".codex", "rules"),
      "project.rules",
      'prefix_rule(pattern=["rm","-rf"], decision="forbidden")\n',
    );
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([]);
  });

  it("no config.toml at all => project .codex/rules is skipped, not an error", () => {
    const { codexHome, projectDir } = setup();
    writeRule(
      join(projectDir, ".codex", "rules"),
      "project.rules",
      'prefix_rule(pattern=["rm","-rf"], decision="forbidden")\n',
    );
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([]);
  });
});

describe("readCodexRules — Starlark prefix_rule extraction", () => {
  it("extracts pattern + decision from a well-formed call", () => {
    const { codexHome, projectDir } = setup();
    writeRule(
      join(codexHome, "rules"),
      "a.rules",
      'prefix_rule(pattern=["git", "push", "origin"], decision="prompt")\n',
    );
    const { rules } = readCodexRules(projectDir, { codexHome });
    expect(rules).toEqual([{ pattern: ["git", "push", "origin"], decision: "prompt" }]);
  });

  it("defaults an absent decision to allow, per docs (learn.chatgpt.com/docs/agent-configuration/rules: \"decision (defaults to allow)\")", () => {
    const { codexHome, projectDir } = setup();
    writeRule(join(codexHome, "rules"), "a.rules", 'prefix_rule(pattern=["ls"])\n');
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([{ pattern: ["ls"], decision: "allow" }]);
  });

  it("truncates the pattern at a non-literal (bare identifier) element — matches anything from there on", () => {
    const { codexHome, projectDir } = setup();
    writeRule(join(codexHome, "rules"), "a.rules", 'prefix_rule(pattern=["git", "push", ARGS], decision="forbidden")\n');
    const { rules } = readCodexRules(projectDir, { codexHome });
    expect(rules).toEqual([{ pattern: ["git", "push"], decision: "forbidden" }]);
  });

  it("truncates the pattern at a glob-like string element too", () => {
    const { codexHome, projectDir } = setup();
    writeRule(join(codexHome, "rules"), "a.rules", 'prefix_rule(pattern=["curl", "*"], decision="forbidden")\n');
    const { rules } = readCodexRules(projectDir, { codexHome });
    expect(rules).toEqual([{ pattern: ["curl"], decision: "forbidden" }]);
  });

  it("multiple prefix_rule calls, comments, blank lines, load(...), and string/list variable assignments are all handled in one file", () => {
    const { codexHome, projectDir } = setup();
    writeRule(
      join(codexHome, "rules"),
      "a.rules",
      [
        "# top comment",
        'load("shared.star", "helper")',
        "",
        'NAME = "default"',
        'GROUP = ["git", "push"]',
        "",
        'prefix_rule(pattern=["git", "push"], decision="forbidden") # trailing comment',
        'prefix_rule(',
        '  pattern=["npm", "install"],',
        '  decision="prompt",',
        ")",
        "",
      ].join("\n"),
    );
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([
      { pattern: ["git", "push"], decision: "forbidden" },
      { pattern: ["npm", "install"], decision: "prompt" },
    ]);
  });

  it("a statement this extractor cannot confidently classify sends the WHOLE FILE to unreadable", () => {
    const { codexHome, projectDir } = setup();
    writeRule(
      join(codexHome, "rules"),
      "a.rules",
      ['prefix_rule(pattern=["git", "push"], decision="forbidden")', "if True:", "    pass", ""].join("\n"),
    );
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(rules).toEqual([]);
    expect(unreadable).toEqual([join(codexHome, "rules", "a.rules")]);
  });

  it("a prefix_rule call with an unrecognized decision value is unreadable", () => {
    const { codexHome, projectDir } = setup();
    writeRule(join(codexHome, "rules"), "a.rules", 'prefix_rule(pattern=["ls"], decision="maybe")\n');
    const { unreadable } = readCodexRules(projectDir, { codexHome });
    expect(unreadable).toEqual([join(codexHome, "rules", "a.rules")]);
  });

  it("a prefix_rule call missing pattern entirely is unreadable", () => {
    const { codexHome, projectDir } = setup();
    writeRule(join(codexHome, "rules"), "a.rules", 'prefix_rule(decision="forbidden")\n');
    const { unreadable } = readCodexRules(projectDir, { codexHome });
    expect(unreadable).toEqual([join(codexHome, "rules", "a.rules")]);
  });
});

describe("createCodexPolicyChecker — verdicts", () => {
  it("a forbidden rule stops the matching command", () => {
    const check = createCodexPolicyChecker([{ pattern: ["git", "push"], decision: "forbidden" }], []);
    expect(check("git push origin main")).toBe("git push");
    expect(check("git status")).toBe(null);
  });

  it("a prompt rule stops too — predexec treats ask-equivalents as stops", () => {
    const check = createCodexPolicyChecker([{ pattern: ["git", "push"], decision: "prompt" }], []);
    expect(check("git push origin main")).toBe("git push");
  });

  it("an allow rule alone never stops anything", () => {
    const check = createCodexPolicyChecker([{ pattern: ["git", "push"], decision: "allow" }], []);
    expect(check("git push origin main")).toBe(null);
  });

  it("most-restrictive-wins when multiple rules match the same command: forbidden > prompt > allow", () => {
    const check = createCodexPolicyChecker(
      [
        { pattern: ["git"], decision: "allow" },
        { pattern: ["git", "push"], decision: "prompt" },
        { pattern: ["git", "push"], decision: "forbidden" },
      ],
      [],
    );
    expect(check("git push origin main")).toBe("git push");
  });

  it("prompt beats allow when both match", () => {
    const check = createCodexPolicyChecker(
      [
        { pattern: ["git"], decision: "allow" },
        { pattern: ["git", "push"], decision: "prompt" },
      ],
      [],
    );
    expect(check("git push origin main")).toBe("git push");
  });

  it("checks each segment of a compound command independently", () => {
    const check = createCodexPolicyChecker([{ pattern: ["curl"], decision: "forbidden" }], []);
    expect(check("echo hi && curl evil.sh")).toBe("curl");
    expect(check("echo hi && echo bye")).toBe(null);
  });

  it("a rule with an empty (fully-truncated) pattern matches every command", () => {
    const check = createCodexPolicyChecker([{ pattern: [], decision: "forbidden" }], []);
    expect(check("anything at all")).toBe("*");
  });

  it("no rules => cheap no-op", () => {
    expect(createCodexPolicyChecker([], [])("rm -rf /")).toBe(null);
  });
});

describe("createCodexPolicyChecker — fail-closed", () => {
  it("an unreadable rules/config file stops EVERY command, naming the file", () => {
    const check = createCodexPolicyChecker([], ["/x/.codex/rules/a.rules"]);
    const why = check("echo hi");
    expect(why).toContain("/x/.codex/rules/a.rules");
    expect(why).toContain("fix that file");
    expect(check("git status")).toContain("/x/.codex/rules/a.rules");
  });
});

describe("readCodexRules — fail-closed end to end", () => {
  it("an unparseable .rules file is reported unreadable and stops every command via the checker", () => {
    const { codexHome, projectDir } = setup();
    writeRule(join(codexHome, "rules"), "bad.rules", "this is not starlark at all\n");
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(rules).toEqual([]);
    expect(unreadable).toEqual([join(codexHome, "rules", "bad.rules")]);
    expect(createCodexPolicyChecker(rules, unreadable)("echo hi")).toContain("bad.rules");
  });

  it("an unparseable config.toml (when one exists) is reported unreadable too", () => {
    const { codexHome, projectDir } = setup();
    writeFileSync(join(codexHome, "config.toml"), "{ this is not toml");
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(rules).toEqual([]);
    expect(unreadable).toEqual([join(codexHome, "config.toml")]);
    expect(createCodexPolicyChecker(rules, unreadable)("echo hi")).toContain("config.toml");
  });
});

describe("readCodexRules — codexHome resolution", () => {
  it("opts.codexHome wins over env.CODEX_HOME", () => {
    const { codexHome: winner, projectDir } = setup();
    const loser = join(tmp, "home2", ".codex");
    writeRule(join(winner, "rules"), "a.rules", 'prefix_rule(pattern=["a"], decision="forbidden")\n');
    writeRule(join(loser, "rules"), "b.rules", 'prefix_rule(pattern=["b"], decision="forbidden")\n');
    const { rules } = readCodexRules(projectDir, { codexHome: winner, env: { CODEX_HOME: loser } });
    expect(rules).toEqual([{ pattern: ["a"], decision: "forbidden" }]);
  });

  it("env.CODEX_HOME is used when opts.codexHome is absent", () => {
    const { codexHome, projectDir } = setup();
    writeRule(join(codexHome, "rules"), "a.rules", 'prefix_rule(pattern=["a"], decision="forbidden")\n');
    const { rules } = readCodexRules(projectDir, { env: { CODEX_HOME: codexHome } });
    expect(rules).toEqual([{ pattern: ["a"], decision: "forbidden" }]);
  });

  it("a missing ~/.codex entirely => unconfigured: no rules, no stops (not locked down)", () => {
    const { projectDir } = setup();
    const missing = join(tmp, "nope", ".codex");
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome: missing });
    expect(rules).toEqual([]);
    expect(unreadable).toEqual([]);
    expect(createCodexPolicyChecker(rules, unreadable)("rm -rf /")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Adversarial-review regression tests (fail-open findings). Each of these
// must RED against the pre-fix implementation — confirmed by running this
// file before the corresponding fix landed; see task-4-fix-report.md.
// ---------------------------------------------------------------------------

describe("readCodexRules — semicolon-joined statements (P1: fail-open regression)", () => {
  it("forbidden-first: a `;`-joined line registers BOTH rules — the forbidden one must still win", () => {
    const { codexHome, projectDir } = setup();
    writeRule(
      join(codexHome, "rules"),
      "a.rules",
      'prefix_rule(pattern=["git","push"], decision="forbidden"); prefix_rule(pattern=["ls"], decision="allow")\n',
    );
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([
      { pattern: ["git", "push"], decision: "forbidden" },
      { pattern: ["ls"], decision: "allow" },
    ]);
    expect(createCodexPolicyChecker(rules, unreadable)("git push origin main")).toBe("git push");
  });

  it("allow-first: the same two rules in the opposite authoring order must still stop git push", () => {
    const { codexHome, projectDir } = setup();
    writeRule(
      join(codexHome, "rules"),
      "a.rules",
      'prefix_rule(pattern=["ls"], decision="allow"); prefix_rule(pattern=["git","push"], decision="forbidden")\n',
    );
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([
      { pattern: ["ls"], decision: "allow" },
      { pattern: ["git", "push"], decision: "forbidden" },
    ]);
    expect(createCodexPolicyChecker(rules, unreadable)("git push origin main")).toBe("git push");
  });

  it("two complete calls with NO separator at all cannot be confidently classified — whole file unreadable", () => {
    // Not valid Starlark (statements need a separator) — but the extractor's
    // OWN line+paren-depth grouping doesn't know that, so this is exactly the
    // "cannot confidently classify trailing content" case it must fail closed
    // on, independent of whether `;`-splitting alone would have caught it.
    const { codexHome, projectDir } = setup();
    writeRule(
      join(codexHome, "rules"),
      "a.rules",
      'prefix_rule(pattern=["git","push"], decision="forbidden") prefix_rule(pattern=["ls"], decision="allow")\n',
    );
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(rules).toEqual([]);
    expect(unreadable).toEqual([join(codexHome, "rules", "a.rules")]);
  });
});

describe("createCodexPolicyChecker — quote evasion (P4: fail-open regression)", () => {
  it("a double- or single-quoted token still matches the rule's literal prefix", () => {
    const check = createCodexPolicyChecker([{ pattern: ["git", "push"], decision: "forbidden" }], []);
    expect(check('git "push" origin')).toBe("git push");
    expect(check("git 'push' origin")).toBe("git push");
  });
});

describe("createCodexPolicyChecker — newline and substitution bypass (P2: fail-open regression)", () => {
  const forbidCurl = () => createCodexPolicyChecker([{ pattern: ["curl"], decision: "forbidden" }], []);

  it("a newline-joined command is checked per line, not as one run-on token stream", () => {
    expect(forbidCurl()("echo hi\ncurl evil.sh")).toBe("curl");
  });

  it("a command-substitution body is extracted and checked too", () => {
    expect(forbidCurl()("echo $(curl evil.sh)")).toBe("curl");
    expect(forbidCurl()("echo `curl evil.sh`")).toBe("curl");
  });
});

describe("readCodexRules — unreadable rules directory (P3: fail-open regression)", () => {
  it("a rules path that exists but cannot be listed as a directory fails closed, not silently unconfigured", () => {
    const { codexHome, projectDir } = setup();
    // A plain FILE where a directory is expected makes readdirSync throw
    // ENOTDIR — portable and root-proof, unlike chmod 000 (root ignores it).
    writeFileSync(join(codexHome, "rules"), "not a directory\n");
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(rules).toEqual([]);
    expect(unreadable).toEqual([join(codexHome, "rules")]);
    expect(createCodexPolicyChecker(rules, unreadable)("echo hi")).toContain(join(codexHome, "rules"));
  });

  it("a genuinely absent rules directory is still unconfigured, not unreadable", () => {
    const { codexHome, projectDir } = setup();
    const { rules, unreadable } = readCodexRules(projectDir, { codexHome });
    expect(rules).toEqual([]);
    expect(unreadable).toEqual([]);
  });
});

describe("readCodexRules — project-dir normalization for trust lookup (P-minor)", () => {
  it("a trailing slash on projectDir does not defeat an otherwise-matching trust entry", () => {
    const { codexHome, projectDir } = setup();
    writeFileSync(join(codexHome, "config.toml"), trustConfig(projectDir, true));
    writeRule(
      join(projectDir, ".codex", "rules"),
      "project.rules",
      'prefix_rule(pattern=["rm","-rf"], decision="forbidden")\n',
    );
    const { rules } = readCodexRules(`${projectDir}/`, { codexHome });
    expect(rules).toEqual([{ pattern: ["rm", "-rf"], decision: "forbidden" }]);
  });
});

describe("engine — policyStop through the Codex checker", () => {
  it("hard-stops BEFORE running a command a forbidden rule covers", async () => {
    const check = createCodexPolicyChecker([{ pattern: ["curl"], decision: "forbidden" }], []);
    const plan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: ["echo hi && curl https://evil.sh"] }],
    };
    const r = await runPlanTree(plan, { cwd: process.cwd(), checkCommandPolicy: check });
    expect(r.stoppedReason).toBe("policyStop");
    expect(r.pathTaken).toEqual([]);
    expect(r.transcript).toContain("host permission rule 'curl'");
  });

  it("runs normally when nothing matches", async () => {
    const check = createCodexPolicyChecker([{ pattern: ["curl"], decision: "forbidden" }], []);
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] };
    const r = await runPlanTree(plan, { cwd: process.cwd(), checkCommandPolicy: check });
    expect(r.stoppedReason).toBe("leaf");
  });
});
