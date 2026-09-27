import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexPolicyChecker,
  readCodexRules as readCodexRulesUnisolated,
  type CodexPolicyOptions,
  type CodexRule,
} from "../../mcp/policy-codex.ts";
import { runPlanTree } from "../../core/engine.ts";
import type { PlanTree } from "../../core/types.ts";

let tmp: string;
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

/**
 * Hermetic by default: without an explicit `systemDir`, the reader would pick
 * up the real `/etc/codex/rules` of whatever machine runs the suite.
 */
const readCodexRules = (cwd: string, opts: CodexPolicyOptions = {}) =>
  readCodexRulesUnisolated(cwd, { systemDir: join(tmp ?? tmpdir(), "no-system-layer"), ...opts });

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

  it("treats a glob-looking \"*\" as a literal token, as Codex does (CX-6)", () => {
    const { codexHome, projectDir } = setup();
    writeRule(join(codexHome, "rules"), "a.rules", 'prefix_rule(pattern=["curl", "*"], decision="forbidden")\n');
    const { rules } = readCodexRules(projectDir, { codexHome });
    expect(rules).toEqual([{ pattern: ["curl", "*"], decision: "forbidden" }]);
    const check = createCodexPolicyChecker(rules, []);
    expect(check("curl example.com")).toBe(null);
    expect(check("curl '*'")).toBe("curl *");
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

  it("an unparseable config.toml projects section is reported unreadable too", () => {
    const { codexHome, projectDir } = setup();
    writeFileSync(join(codexHome, "config.toml"), '[projects."/x"]\ntrust_level = { this is not toml\n');
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

describe("createCodexPolicyChecker — leading env-assignment / wrapper bypass (safety-parity regression)", () => {
  it("a leading NAME=value assignment does not defeat a forbidden prefix rule", () => {
    const check = createCodexPolicyChecker([{ pattern: ["git", "push"], decision: "forbidden" }], []);
    expect(check("FOO=1 git push origin main")).toBe("git push");
  });

  it("multiple leading assignments are all stripped before matching", () => {
    const check = createCodexPolicyChecker([{ pattern: ["git", "push"], decision: "forbidden" }], []);
    expect(check("FOO=1 BAR=2 git push origin main")).toBe("git push");
  });

  it("a wrapper command (timeout) does not defeat a forbidden prefix rule", () => {
    const check = createCodexPolicyChecker([{ pattern: ["git", "push"], decision: "forbidden" }], []);
    expect(check("timeout 5 git push origin main")).toBe("git push");
  });

  it("still matches a rule that targets the wrapper itself", () => {
    const check = createCodexPolicyChecker([{ pattern: ["timeout"], decision: "forbidden" }], []);
    expect(check("timeout 5 git push origin main")).toBe("timeout");
  });

  it.each([
    "time -p curl https://example.invalid",
    "time -f %E curl https://example.invalid",
    "time --format %E curl https://example.invalid",
    "time -o timing.log curl https://example.invalid",
    "time --output timing.log curl https://example.invalid",
    "time -ao timing.log curl https://example.invalid",
  ])("matches the inner command after time options: %s", (command) => {
    const check = createCodexPolicyChecker([{ pattern: ["curl"], decision: "forbidden" }], []);
    expect(check(command)).toBe("curl");
  });
});

describe("createCodexPolicyChecker — newline and substitution bypass (P2: fail-open regression)", () => {
  const forbidCurl = () => createCodexPolicyChecker([{ pattern: ["curl"], decision: "forbidden" }], []);

  it.each([
    "f() { curl https://example.invalid; }; f",
    "f ()\n{\n curl https://example.invalid\n}\nf",
    "function f { curl https://example.invalid; }; f",
  ])("checks commands inside function definitions: %s", (command) => {
    expect(forbidCurl()(command)).toBe("curl");
  });

  it("checks nested case branches without treating inner esac as outer coverage", () => {
    expect(forbidCurl()("case x in a) case y in b) curl https://example.invalid ;; c) echo ok ;; esac ;; d) printf ok ;; esac")).toBe("curl");
  });

  it("checks functions in nested cases and suffix commands", () => {
    const check = createCodexPolicyChecker([{ pattern: ["touch"], decision: "forbidden" }], []);
    expect(check("case x in a) case y in b) f(){ touch /tmp/x; }; f ;; esac ;; esac")).toBe("touch");
    expect(check("case x in a) echo ok ;; esac; touch /tmp/x")).toBe("touch");
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
  ])("checks mkdir after non-leading reserved words: %s", (command) => {
    const check = createCodexPolicyChecker([{ pattern: ["mkdir"], decision: "forbidden" }], []);
    expect(check(command)).toBe("mkdir");
  });

  it("a newline-joined command is checked per line, not as one run-on token stream", () => {
    expect(forbidCurl()("echo hi\ncurl evil.sh")).toBe("curl");
  });

  it("a command-substitution body is extracted and checked too", () => {
    expect(forbidCurl()("echo $(curl evil.sh)")).toBe("curl");
    expect(forbidCurl()("echo `curl evil.sh`")).toBe("curl");
  });

  it.each([
    "{ git push origin main; }",
    "if git push origin main; then :; fi",
    'echo "$(git push origin main)"',
  ])("inspects commands inside shell clauses and substitutions: %s", (command) => {
    const check = createCodexPolicyChecker([{ pattern: ["git", "push"], decision: "forbidden" }], []);
    expect(check(command)).toBe("git push");
  });

  it("does not inspect a literal single-quoted substitution", () => {
    const check = createCodexPolicyChecker([{ pattern: ["git", "push"], decision: "forbidden" }], []);
    expect(check("echo '$(git push origin main)'")).toBeNull();
  });

  it("matches a command after a quoted multi-word time format", () => {
    const check = createCodexPolicyChecker([{ pattern: ["curl"], decision: "forbidden" }], []);
    expect(check('time -f "%E %U" curl https://example.invalid')).toBe("curl");
  });

  it("continues inspecting nested substitutions beyond four levels", () => {
    const command = `${"echo $(".repeat(6)}curl https://example.invalid${")".repeat(6)}`;
    expect(forbidCurl()(command)).toBe("curl");
  });

  it("fails closed when substitution inspection exceeds its bounded budget", () => {
    const command = `${"echo $(".repeat(40)}curl https://example.invalid${")".repeat(40)}`;
    expect(forbidCurl()(command)).toContain("incomplete shell syntax");
  });

  it("checks each case branch and coprocess body", () => {
    expect(forbidCurl()("case x in a) echo ok ;; b) curl https://example.invalid ;; esac")).toBe("curl");
    expect(forbidCurl()("coproc curl https://example.invalid")).toBe("curl");
  });

  it.each([
    "(curl https://example.invalid)",
    "! (curl https://example.invalid)",
    "if (curl https://example.invalid); then :; fi",
    "case x in a) (curl https://example.invalid) ;; esac",
    "if (while true; do (curl https://example.invalid); done); then :; fi",
  ])("checks denied commands at every control depth: %s", (command) => {
    expect(forbidCurl()(command)).toBe("curl");
  });

  it.each([
    "case x in a) echo first b) echo second ;; esac",
    "case x in a) echo first ;; b) echo second c) echo third ;; esac",
    "case x in a) echo first ;; b) echo second esac",
    "case x in orphan ;; a) echo ok ;; esac",
    "case x in a) echo ok ;; orphan ;; esac",
    "case x in a) echo ok ;; orphan esac",
  ])("fails closed rather than dropping malformed case bodies: %s", (command) => {
    expect(forbidCurl()(command)).toContain("incomplete shell syntax");
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
    const r = await runPlanTree(plan, { cwd: process.cwd(), checkOperationPolicy: check });
    expect(r.stoppedReason).toBe("policyStop");
    expect(r.pathTaken).toEqual([]);
    expect(r.transcript).toContain("host permission rule 'curl'");
  });

  it("runs normally when nothing matches", async () => {
    const check = createCodexPolicyChecker([{ pattern: ["curl"], decision: "forbidden" }], []);
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] };
    const r = await runPlanTree(plan, { cwd: process.cwd(), checkOperationPolicy: check });
    expect(r.stoppedReason).toBe("leaf");
  });
});

// ---------------------------------------------------------------------------
// Task 13 — Codex policy fidelity (CX-1, CX-2, CX-3, CX-4, CX-6, CX-7)
// ---------------------------------------------------------------------------

/** An isolated fs layout with no system layer leaking in from the real machine. */
function setupLayers() {
  const { codexHome, projectDir } = setup();
  const systemDir = join(tmp, "etc-codex");
  return { codexHome, projectDir, systemDir, opts: { codexHome, systemDir, env: { HOME: join(tmp, "home") } } };
}

/** `<dir>/.git/HEAD` — a real repo marker (Codex requires HEAD in a `.git` dir). */
function makeRepo(dir: string) {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

describe("readCodexRules — host-written rules files (CX-1)", () => {
  it("skips network_rule(...) and host_executable(...) and keeps enforcing prefix rules", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeRule(
      join(codexHome, "rules"),
      "default.rules",
      [
        'network_rule(host="example.com", protocol="https", decision="deny", justification="no (really)")',
        'host_executable(name="git", paths=["/usr/bin/git", "/opt/homebrew/bin/git"])',
        'prefix_rule(pattern=["rm"], decision="forbidden")',
        "",
      ].join("\n"),
    );
    const { rules, unreadable } = readCodexRules(projectDir, opts);
    expect(unreadable).toEqual([]);
    const check = createCodexPolicyChecker(rules, unreadable);
    expect(check("ls")).toBe(null);
    expect(check("rm x")).toBe("rm");
  });

  it("an unknown top-level call still fails the file closed", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeRule(join(codexHome, "rules"), "a.rules", 'mystery_rule(pattern=["rm"])\nprefix_rule(pattern=["rm"], decision="forbidden")\n');
    expect(readCodexRules(projectDir, opts).unreadable).toEqual([join(codexHome, "rules", "a.rules")]);
  });
});

describe("readCodexRules — host-written config.toml (CX-1, CX-7)", () => {
  const hostWritten = (projectDir: string, trustLine: string) =>
    [
      'model = "gpt-5"',
      "tui.theme = 'dark'",
      'note = "caf\\u00e9 é"',
      "big = 1_000",
      "sci = 1e5",
      'blurb = """',
      'multi line"""',
      'shell_environment_policy = { inherit = "core" }',
      "",
      "[[skills.config]]",
      'path = "/s/one"',
      "enabled = false",
      "",
      `[projects."${projectDir}"]`,
      trustLine,
      "",
    ].join("\n");

  it("reads trust correctly through every construct Codex itself writes", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeFileSync(join(codexHome, "config.toml"), hostWritten(projectDir, 'trust_level = "trusted"'));
    writeRule(join(projectDir, ".codex", "rules"), "p.rules", 'prefix_rule(pattern=["rm"], decision="forbidden")\n');
    const { rules, unreadable } = readCodexRules(projectDir, opts);
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([{ pattern: ["rm"], decision: "forbidden" }]);
  });

  it("the same file with a malformed [projects.*] section fails closed", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeFileSync(join(codexHome, "config.toml"), hostWritten(projectDir, "trust_level = trusted"));
    expect(readCodexRules(projectDir, opts).unreadable).toEqual([join(codexHome, "config.toml")]);
  });

  it("a duplicate [a] header fails closed", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeFileSync(join(codexHome, "config.toml"), "[a]\nx = 1\n[a]\ny = 2\n");
    expect(readCodexRules(projectDir, opts).unreadable).toEqual([join(codexHome, "config.toml")]);
  });

  it("a tolerated error outside projects is a debug-only warning, never a stop", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeFileSync(join(codexHome, "config.toml"), '[tui]\nx = "broken\n');
    const result = readCodexRules(projectDir, opts);
    expect(result.unreadable).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("config.toml")]);
    expect(createCodexPolicyChecker(result.rules, result.unreadable)("echo hi")).toBe(null);
  });

  it("a trust_level Codex would reject (not trusted/untrusted) fails closed", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeFileSync(join(codexHome, "config.toml"), trustConfig(projectDir, true).replace('"trusted"', '"yes"'));
    expect(readCodexRules(projectDir, opts).unreadable).toEqual([join(codexHome, "config.toml")]);
  });
});

describe("readCodexRules — layered trust and project root (CX-2)", () => {
  it("a session in <trusted repo>/sub/dir applies the repo's .codex/rules", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    makeRepo(projectDir);
    writeFileSync(join(codexHome, "config.toml"), trustConfig(projectDir, true));
    writeRule(join(projectDir, ".codex", "rules"), "p.rules", 'prefix_rule(pattern=["cat", ".env"], decision="forbidden")\n');
    const sub = join(projectDir, "sub", "dir");
    mkdirSync(sub, { recursive: true });
    const { rules, unreadable } = readCodexRules(sub, opts);
    expect(unreadable).toEqual([]);
    expect(createCodexPolicyChecker(rules, unreadable)("cat .env")).toBe("cat .env");
  });

  it("a session via a symlink to the repo applies the repo's .codex/rules", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    makeRepo(projectDir);
    writeFileSync(join(codexHome, "config.toml"), trustConfig(realpathSync(projectDir), true));
    writeRule(join(projectDir, ".codex", "rules"), "p.rules", 'prefix_rule(pattern=["cat", ".env"], decision="forbidden")\n');
    const link = join(tmp, "link");
    symlinkSync(projectDir, link);
    const { rules } = readCodexRules(join(link), opts);
    expect(createCodexPolicyChecker(rules, [])("cat .env")).toBe("cat .env");
  });

  it("loads .codex/rules of every directory from the project root down to cwd", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    makeRepo(projectDir);
    writeFileSync(join(codexHome, "config.toml"), trustConfig(projectDir, true));
    const sub = join(projectDir, "sub");
    writeRule(join(projectDir, ".codex", "rules"), "root.rules", 'prefix_rule(pattern=["a"], decision="forbidden")\n');
    writeRule(join(sub, ".codex", "rules"), "sub.rules", 'prefix_rule(pattern=["b"], decision="forbidden")\n');
    const { rules } = readCodexRules(sub, opts);
    expect(rules).toEqual([
      { pattern: ["a"], decision: "forbidden" },
      { pattern: ["b"], decision: "forbidden" },
    ]);
  });

  it("a linked worktree inherits trust from the main worktree root", () => {
    const { codexHome, opts } = setupLayers();
    const main = join(tmp, "main");
    makeRepo(main);
    const admin = join(main, ".git", "worktrees", "wt");
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, "commondir"), "../..\n");
    const wt = join(tmp, "wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${admin}\n`);
    writeFileSync(join(codexHome, "config.toml"), trustConfig(main, true));
    writeRule(join(wt, ".codex", "rules"), "w.rules", 'prefix_rule(pattern=["rm"], decision="forbidden")\n');
    const { rules } = readCodexRules(wt, opts);
    expect(rules).toEqual([{ pattern: ["rm"], decision: "forbidden" }]);
  });

  it("honors project_root_markers from config.toml", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeFileSync(join(projectDir, ".root-marker"), "");
    writeFileSync(
      join(codexHome, "config.toml"),
      `project_root_markers = [".root-marker"]\n${trustConfig(projectDir, true)}`,
    );
    writeRule(join(projectDir, ".codex", "rules"), "p.rules", 'prefix_rule(pattern=["rm"], decision="forbidden")\n');
    const sub = join(projectDir, "deep");
    mkdirSync(sub);
    expect(readCodexRules(sub, opts).rules).toEqual([{ pattern: ["rm"], decision: "forbidden" }]);
  });

  it("an untrusted repo still skips every .codex layer", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    makeRepo(projectDir);
    writeFileSync(join(codexHome, "config.toml"), trustConfig(projectDir, false));
    writeRule(join(projectDir, ".codex", "rules"), "p.rules", 'prefix_rule(pattern=["rm"], decision="forbidden")\n');
    const sub = join(projectDir, "sub");
    mkdirSync(sub);
    expect(readCodexRules(sub, opts).rules).toEqual([]);
  });
});

describe("readCodexRules — system layer and CODEX_HOME (CX-3, CX-4)", () => {
  it("reads <systemDir>/rules (default /etc/codex/rules)", () => {
    const { projectDir, systemDir, opts } = setupLayers();
    writeRule(join(systemDir, "rules"), "x.rules", 'prefix_rule(pattern=["cat"], decision="forbidden")\n');
    const { rules, unreadable } = readCodexRules(projectDir, opts);
    expect(createCodexPolicyChecker(rules, unreadable)("cat notes.txt")).toBe("cat");
  });

  it("reads the system layer even when there is no Codex home at all", () => {
    const { projectDir, systemDir } = setupLayers();
    writeRule(join(systemDir, "rules"), "x.rules", 'prefix_rule(pattern=["cat"], decision="forbidden")\n');
    const { rules } = readCodexRules(projectDir, { codexHome: join(tmp, "absent"), systemDir });
    expect(rules).toEqual([{ pattern: ["cat"], decision: "forbidden" }]);
  });

  it("honors env CODEX_HOME for rules and trust", () => {
    const { projectDir, systemDir } = setupLayers();
    const ch = join(tmp, "ch");
    writeRule(join(ch, "rules"), "a.rules", 'prefix_rule(pattern=["curl"], decision="forbidden")\n');
    const { rules } = readCodexRules(projectDir, { systemDir, env: { CODEX_HOME: ch, HOME: join(tmp, "home") } });
    expect(rules).toEqual([{ pattern: ["curl"], decision: "forbidden" }]);
  });
});

describe("readCodexRules — pattern fidelity (CX-6)", () => {
  const read = (rule: string) => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeRule(join(codexHome, "rules"), "a.rules", `${rule}\n`);
    const { rules, unreadable } = readCodexRules(projectDir, opts);
    expect(unreadable).toEqual([]);
    return createCodexPolicyChecker(rules, unreadable);
  };

  it("alternatives in the first position match either head, not everything", () => {
    const check = read('prefix_rule(pattern=[["rm","rmdir"],"-rf"], decision="forbidden")');
    expect(check("rmdir -rf x")).not.toBe(null);
    expect(check("rm -rf x")).not.toBe(null);
    expect(check("ls")).toBe(null);
    expect(check("rm x")).toBe(null);
  });

  it("alternatives in a later position", () => {
    const check = read('prefix_rule(pattern=["git",["push","pull"]], decision="forbidden")');
    expect(check("git pull")).not.toBe(null);
    expect(check("git status")).toBe(null);
  });

  it("backslash escapes are unescaped: \"a\\\\b\" matches a\\b", () => {
    const check = read('prefix_rule(pattern=["a\\\\b"], decision="forbidden")');
    expect(check("'a\\b'")).not.toBe(null);
    expect(check("'a\\\\b'")).toBe(null);
  });

  it('"*" matches only a literal *', () => {
    const check = read('prefix_rule(pattern=["*"], decision="forbidden")');
    expect(check("ls")).toBe(null);
    expect(check("'*'")).toBe("*");
  });

  it("an empty pattern is invalid in Codex, so the file fails closed", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeRule(join(codexHome, "rules"), "a.rules", 'prefix_rule(pattern=[], decision="forbidden")\n');
    expect(readCodexRules(projectDir, opts).unreadable).toEqual([join(codexHome, "rules", "a.rules")]);
  });
});

describe("createCodexPolicyChecker — backslash-newline continuation (carried forward)", () => {
  it("cat \\<newline>.env cannot dodge a forbidden [cat, .env] rule", () => {
    const check = createCodexPolicyChecker([{ pattern: ["cat", ".env"], decision: "forbidden" }], []);
    expect(check("cat \\\n.env")).toBe("cat .env");
  });

  it("a backslash-newline inside single quotes stays literal", () => {
    const check = createCodexPolicyChecker([{ pattern: ["echo", "ab"], decision: "forbidden" }], []);
    expect(check("echo 'a\\\nb'")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Task 13 review, fix round 1 (I1, I2, I3, Minor 1, R37)
// ---------------------------------------------------------------------------

describe("readCodexRules — triple-quoted strings in rules files (review I1)", () => {
  const read = (body: string) => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeRule(join(codexHome, "rules"), "a.rules", body);
    return readCodexRules(projectDir, opts);
  };

  it("an apostrophe inside a ''' justification does not make the file unreadable", () => {
    const { rules, unreadable } = read(
      "prefix_rule(pattern=[\"git\",\"push\"], decision=\"forbidden\", justification='''Don't push''')\n",
    );
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([{ pattern: ["git", "push"], decision: "forbidden" }]);
  });

  it('a forbidden rule between two network_rule calls with odd-quote """ strings is still enforced', () => {
    const { rules, unreadable } = read(
      'network_rule(host="a", protocol="https", decision="allow", justification="""a"b"""); ' +
        "prefix_rule(pattern=['rm'], decision='forbidden'); " +
        'network_rule(host="c", protocol="https", decision="allow", justification="""c"d""")\n',
    );
    expect(unreadable).toEqual([]);
    expect(createCodexPolicyChecker(rules, unreadable)("rm x")).toBe("rm");
  });

  it('a forbidden rule after a prefix_rule carrying an odd-quote """ justification is still enforced', () => {
    const { rules, unreadable } = read(
      'prefix_rule(pattern=["ls"], justification="""a"b"""); prefix_rule(pattern=["rm"], decision="forbidden")\n',
    );
    expect(unreadable).toEqual([]);
    expect(createCodexPolicyChecker(rules, unreadable)("rm x")).toBe("rm");
  });

  it("a multi-line ''' string containing parens and # is one string, not code", () => {
    const { rules, unreadable } = read(
      "prefix_rule(\n  pattern=[\"rm\"],\n  decision=\"forbidden\",\n  justification='''no (really)\n# not a comment\n''',\n)\n",
    );
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([{ pattern: ["rm"], decision: "forbidden" }]);
  });
});

describe("readCodexRules — skipped / ignored arguments must be literals (review I2, Minor 1)", () => {
  const unreadableFor = (body: string) => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeRule(join(codexHome, "rules"), "a.rules", body);
    return readCodexRules(projectDir, opts).unreadable;
  };

  it.each([
    [
      "a nested prefix_rule inside a skipped network_rule",
      'network_rule(host="a", protocol="https", decision="allow", justification=str(prefix_rule(pattern=["rm"], decision="forbidden")))\n',
    ],
    [
      "a nested prefix_rule inside an ignored prefix_rule kwarg",
      'prefix_rule(pattern=["ls"], justification=str(prefix_rule(pattern=["rm"], decision="forbidden")))\n',
    ],
    ["an identifier reference inside host_executable", 'host_executable(name="git", paths=GIT_PATHS)\n'],
    ["a duplicate decision kwarg", 'prefix_rule(pattern=["rm"], decision="forbidden", decision="allow")\n'],
    ["an unknown (typo'd) kwarg", 'prefix_rule(pattern=["rm"], decison="forbidden")\n'],
  ])("%s fails the file closed", (_name, body) => {
    expect(unreadableFor(body)).toHaveLength(1);
  });

  it("literal-only arguments are still accepted, including match/not_match examples", () => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeRule(
      join(codexHome, "rules"),
      "a.rules",
      [
        'network_rule(host="example.com", protocol="https", decision="deny", justification="no")',
        'host_executable(name="git", paths=["/usr/bin/git"])',
        'prefix_rule(pattern=["git","push"], decision="forbidden", match=[["git","push"], "git push -f"], not_match=["git status"], justification="no")',
        "",
      ].join("\n"),
    );
    const { rules, unreadable } = readCodexRules(projectDir, opts);
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([{ pattern: ["git", "push"], decision: "forbidden" }]);
  });
});

describe("createCodexPolicyChecker — absolute-path program heads (review I3)", () => {
  it("/bin/rm x matches an [rm] rule by basename, as Codex's resolve_host_executables does", () => {
    const check = createCodexPolicyChecker([{ pattern: ["rm"], decision: "forbidden" }], []);
    expect(check("/bin/rm x")).toBe("rm");
    expect(check("/usr/bin/env ls")).toBe(null);
  });

  it("the basename form also applies to multi-token rules", () => {
    const check = createCodexPolicyChecker([{ pattern: ["cat", ".env"], decision: "prompt" }], []);
    expect(check("/usr/bin/cat .env")).toBe("cat .env");
  });
});

describe("readCodexRules — project-root search has no ceiling (review R37)", () => {
  it("finds a marker above $HOME's parent, as Codex does", () => {
    const { codexHome, systemDir } = setupLayers();
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const home = join(repo, "users", "me");
    const cwd = join(home, "work");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), trustConfig(repo, true));
    writeRule(join(repo, ".codex", "rules"), "r.rules", 'prefix_rule(pattern=["rm"], decision="forbidden")\n');
    const { rules } = readCodexRules(cwd, { codexHome, systemDir, env: { HOME: home } });
    expect(rules).toEqual([{ pattern: ["rm"], decision: "forbidden" }]);
  });
});

describe("readCodexRules — a triple-quoted literal ends at its FIRST closing delimiter (review I2, round 2)", () => {
  const nested = 'str(prefix_rule(pattern=["rm"], decision="forbidden"))';
  it.each([
    ["network_rule justification (\"\"\")", `network_rule(host="a", protocol="https", decision="allow", justification="""a""" + ${nested} + """b""")`],
    ["network_rule justification (''')", `network_rule(host="a", protocol="https", decision="allow", justification='''a''' + ${nested} + '''b''')`],
    ["prefix_rule justification", `prefix_rule(pattern=["ls"], justification="""a""" + ${nested} + """b""")`],
    ["a pattern element", 'prefix_rule(pattern=["""ls""" if prefix_rule(pattern=["rm"], decision="forbidden") else """ls"""])'],
    ["an assignment right-hand side", `X = """a""" + ${nested} + """b"""`],
  ])("%s: the nested forbidden rule is never silently dropped", (_name, body) => {
    const { projectDir, codexHome, opts } = setupLayers();
    writeRule(join(codexHome, "rules"), "a.rules", `${body}\n`);
    const { rules, unreadable } = readCodexRules(projectDir, opts);
    const check = createCodexPolicyChecker(rules, unreadable);
    expect(check("rm x")).not.toBe(null);
    expect(unreadable).toEqual([join(codexHome, "rules", "a.rules")]);
  });
});

// Final review #7: Codex merges `/etc/codex/config.toml` UNDER the user
// config before deciding trust and project_root_markers
// (codex-rs/config/src/loader/mod.rs load_config_layers_state: system layer,
// then user layers, merged with merge_toml_values — tables merge per key, a
// later scalar/array replaces an earlier one).
describe("readCodexRules — system config.toml trust layer", () => {
  const forbidRm = 'prefix_rule(pattern=["rm","-rf"], decision="forbidden")\n';

  it("a project trusted only in the system config loads its .codex/rules", () => {
    const { projectDir, systemDir, opts } = setupLayers();
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, "config.toml"), trustConfig(projectDir, true));
    writeRule(join(projectDir, ".codex", "rules"), "p.rules", forbidRm);
    const { rules, unreadable } = readCodexRules(projectDir, opts);
    expect(unreadable).toEqual([]);
    expect(rules).toEqual([{ pattern: ["rm", "-rf"], decision: "forbidden" }]);
  });

  it("the user config overrides the system config for the same project key", () => {
    const { codexHome, projectDir, systemDir, opts } = setupLayers();
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, "config.toml"), trustConfig(projectDir, true));
    writeFileSync(join(codexHome, "config.toml"), trustConfig(projectDir, false));
    writeRule(join(projectDir, ".codex", "rules"), "p.rules", forbidRm);
    expect(readCodexRules(projectDir, opts).rules).toEqual([]);
  });

  it("a user entry without trust_level keeps the system trust (tables merge per key)", () => {
    const { codexHome, projectDir, systemDir, opts } = setupLayers();
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, "config.toml"), trustConfig(projectDir, true));
    writeFileSync(join(codexHome, "config.toml"), `[projects."${projectDir}"]\nnote = "x"\n`);
    writeRule(join(projectDir, ".codex", "rules"), "p.rules", forbidRm);
    expect(readCodexRules(projectDir, opts).rules).toEqual([{ pattern: ["rm", "-rf"], decision: "forbidden" }]);
  });

  it("system project_root_markers apply when the user config sets none", () => {
    const { projectDir, systemDir, opts } = setupLayers();
    const sub = join(projectDir, "pkg");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(projectDir, "ROOT_MARK"), "");
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, "config.toml"), `project_root_markers = ["ROOT_MARK"]\n${trustConfig(projectDir, true)}`);
    writeRule(join(projectDir, ".codex", "rules"), "p.rules", forbidRm);
    expect(readCodexRules(sub, opts).rules).toEqual([{ pattern: ["rm", "-rf"], decision: "forbidden" }]);
  });

  it("the user's project_root_markers replace the system's", () => {
    const { codexHome, projectDir, systemDir, opts } = setupLayers();
    const sub = join(projectDir, "pkg");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(projectDir, "ROOT_MARK"), "");
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, "config.toml"), `project_root_markers = ["ROOT_MARK"]\n${trustConfig(projectDir, true)}`);
    writeFileSync(join(codexHome, "config.toml"), `project_root_markers = []\n`);
    writeRule(join(projectDir, ".codex", "rules"), "p.rules", forbidRm);
    // No markers: the project root is cwd (pkg), which is not trusted.
    expect(readCodexRules(sub, opts).rules).toEqual([]);
  });

  it("an unparseable system config.toml fails closed", () => {
    const { projectDir, systemDir, opts } = setupLayers();
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, "config.toml"), "[projects\ntrust_level = ");
    const { unreadable } = readCodexRules(projectDir, opts);
    expect(unreadable).toEqual([join(systemDir, "config.toml")]);
  });

  it("a system config with a wrong-shaped projects table fails closed", () => {
    const { projectDir, systemDir, opts } = setupLayers();
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, "config.toml"), 'projects = "nope"\n');
    expect(readCodexRules(projectDir, opts).unreadable).toEqual([join(systemDir, "config.toml")]);
  });
});

describe("data-fed operands (E-B): stop when a rule could match the command that receives them", () => {
  const check = (rules: CodexRule[]) => createCodexPolicyChecker(rules, []);

  it.each([
    "echo .env | xargs cat",
    "while read f; do cat \"$f\"; done < list",
    "cat $(cat names.txt)",
  ])("forbidden [\"cat\",\".env\"] stops %s", (command) => {
    expect(check([{ pattern: ["cat", ".env"], decision: "forbidden" }])(command)).toMatch(/operands of 'cat'.*can't be checked/);
  });

  it("prompt rules, alternatives and the match-everything rule count; allow and unrelated rules do not", () => {
    expect(check([{ pattern: ["cat", ".env"], decision: "prompt" }])("echo .env | xargs cat")).toBeTruthy();
    expect(check([{ pattern: [["head", "cat"], ".env"], decision: "forbidden" }])("echo .env | xargs cat")).toBeTruthy();
    expect(check([{ pattern: [], decision: "forbidden" }])("echo .env | xargs cat")).toBeTruthy();
    expect(check([{ pattern: ["cat", ".env"], decision: "allow" }])("echo .env | xargs cat")).toBeNull();
    expect(check([{ pattern: ["git", "push"], decision: "forbidden" }])("echo .env | xargs cat")).toBeNull();
  });

  it("with no rule naming cat, the xargs read runs normally", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "px-codex-operands-")));
    try {
      writeFileSync(join(dir, "note.txt"), "PLAIN\n");
      const r = await runPlanTree(
        { root: "a", nodes: [{ id: "a", commands: ["echo note.txt | xargs cat"] }] },
        { cwd: dir, checkOperationPolicy: check([{ pattern: ["git", "push"], decision: "forbidden" }]) },
      );
      expect(r.stoppedReason).not.toBe("policyStop");
      expect(r.transcript).toContain("PLAIN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fix round 1: xargs shell payloads, find -exec and parallel (Codex)", () => {
  it.each([
    "cat list | xargs -I{} sh -c 'cat {}'",
    "find . -name '.e*' -exec cat {} +",
    "find . -name '.e*' -execdir cat {} \;",
    "cat list | parallel cat",
    "parallel cat :::: list",
  ])("forbidden [\"cat\",\".env\"] stops %s", (command) => {
    expect(createCodexPolicyChecker([{ pattern: ["cat", ".env"], decision: "forbidden" }], [])(command)).toMatch(/operands of 'cat'.*can't be checked/);
  });
});
