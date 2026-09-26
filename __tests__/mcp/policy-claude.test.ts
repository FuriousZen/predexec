import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeSettingsPaths,
  compileClaudePathRule,
  createClaudeHostPolicyChecker,
  detectManagedPolicySources,
  createClaudePolicyChecker,
  createClaudeOperationPolicyChecker,
  parseClaudeBashRules,
  parseClaudeOperationRules,
  readClaudeBashRules,
  stripBashWrappers,
} from "../../mcp/policy-claude.ts";
import { runPlanTree } from "../../core/engine.ts";
import type { PlanTree } from "../../core/types.ts";

describe("parseClaudeBashRules — settings shapes", () => {
  it("extracts Bash(...) patterns from deny, ask and allow", () => {
    const rules = parseClaudeBashRules(
      JSON.stringify({
        permissions: {
          deny: ["Bash(curl *)"],
          ask: ["Bash(git push *)"],
          allow: ["Bash(npm run *)"],
        },
      }),
    );
    expect(rules).toEqual([
      { pattern: "curl *", action: "deny" },
      { pattern: "git push *", action: "ask" },
      { pattern: "npm run *", action: "allow" },
    ]);
  });

  it("skips rules for other tools", () => {
    // Read/Edit/WebFetch rules gate tools this checker does not speak for.
    expect(
      parseClaudeBashRules('{"permissions":{"deny":["Read(./.env)","WebFetch(domain:*)","Edit(docs/**)"]}}'),
    ).toEqual([]);
  });

  it("bare Bash and Bash(*) both mean every command", () => {
    // Docs: "`Bash(*)` is equivalent to `Bash` and matches all Bash commands."
    // Skipping the bare form would be the largest possible under-conservatism.
    expect(parseClaudeBashRules('{"permissions":{"deny":["Bash"]}}')).toEqual([{ pattern: "*", action: "deny" }]);
    expect(parseClaudeBashRules('{"permissions":{"ask":["Bash(*)"]}}')).toEqual([{ pattern: "*", action: "ask" }]);
  });

  it("tool-name globs: '*' covers Bash, 'mcp__*' does not", () => {
    expect(parseClaudeBashRules('{"permissions":{"deny":["*"]}}')).toEqual([{ pattern: "*", action: "deny" }]);
    expect(parseClaudeBashRules('{"permissions":{"deny":["B*"]}}')).toEqual([{ pattern: "*", action: "deny" }]);
    // Over-stopping until predexec never runs is a failure too, just a quiet one.
    expect(parseClaudeBashRules('{"permissions":{"deny":["mcp__*"]}}')).toEqual([]);
    // Allow-rule globs never auto-approve bash, so they never become rules.
    expect(parseClaudeBashRules('{"permissions":{"allow":["*"]}}')).toEqual([]);
  });

  it("IGNORES the parameter form Bash(command:rm *), as Claude Code itself does", () => {
    // The host ignores it and warns, because a compound command would bypass
    // it. Honoring it would make predexec stricter-than-AND-different-from the
    // host, which only confuses users.
    expect(parseClaudeBashRules('{"permissions":{"deny":["Bash(command:rm *)"]}}')).toEqual([]);
    // Whitespace around the colon is ignored by the host.
    expect(parseClaudeBashRules('{"permissions":{"deny":["Bash(command : rm *)"]}}')).toEqual([]);
    // Other Bash input parameters say nothing about command text.
    expect(parseClaudeBashRules('{"permissions":{"deny":["Bash(run_in_background:true)"]}}')).toEqual([]);
    // But `git` is not a Bash parameter: the colon there is literal.
    expect(parseClaudeBashRules('{"permissions":{"deny":["Bash(git:* push)"]}}')).toEqual([
      { pattern: "git:* push", action: "deny" },
    ]);
  });

  it("keeps the trailing :* alias intact for the compiler", () => {
    expect(parseClaudeBashRules('{"permissions":{"deny":["Bash(ls:*)"]}}')).toEqual([
      { pattern: "ls:*", action: "deny" },
    ]);
  });

  it("orders deny before ask before allow, as Claude Code evaluates them", () => {
    const rules = parseClaudeBashRules(
      '{"permissions":{"allow":["Bash(a *)"],"ask":["Bash(b *)"],"deny":["Bash(c *)"]}}',
    );
    expect(rules.map((r) => r.action)).toEqual(["deny", "ask", "allow"]);
  });

  it("missing / junk permissions => no rules", () => {
    expect(parseClaudeBashRules("{}")).toEqual([]);
    expect(parseClaudeBashRules('{"permissions":{}}')).toEqual([]);
    expect(parseClaudeBashRules('{"permissions":[1,2]}')).toEqual([]);
    expect(parseClaudeBashRules('{"permissions":{"deny":"Bash(rm *)"}}')).toEqual([]);
    expect(parseClaudeBashRules('{"permissions":{"deny":[1,null,{}]}}')).toEqual([]);
  });

  it("throws on malformed JSON so the caller can fail closed", () => {
    // Claude Code settings are strict JSON — no comment stripping here, unlike
    // opencode's .jsonc.
    expect(() => parseClaudeBashRules("{not json")).toThrow();
    expect(() => parseClaudeBashRules('{ // nope\n"permissions":{}}')).toThrow();
  });
});

describe("Claude native operation policy", () => {
  it("maps documented Read, Grep, and Glob entries to native operations", () => {
    const text = JSON.stringify({
      permissions: {
        deny: ["Read(./.env)", "Grep(./secrets/**)"],
        ask: ["Glob(./private/**)"],
      },
    });
    expect(parseClaudeOperationRules(text)).toEqual([
      { tool: "read", pattern: "./.env", action: "deny" },
      { tool: "grep", pattern: "./secrets/**", action: "deny" },
      { tool: "find", pattern: "./private/**", action: "ask" },
    ]);
  });

  it("stops matching native operations while unrelated paths pass", () => {
    const check = createClaudeOperationPolicyChecker([
      { tool: "read", pattern: "./.env", action: "deny" },
      { tool: "grep", pattern: "./secrets/**", action: "deny" },
      { tool: "find", pattern: "./private/**", action: "ask" },
    ]);
    expect(check({ tool: "read", path: "./.env" })).toBe("./.env");
    expect(check({ tool: "grep", path: "./secrets/key", pattern: "key" })).toBe("./secrets/**");
    expect(check({ tool: "find", path: "./private", pattern: "*" })).toBe("./private/**");
    expect(check({ tool: "read", path: "README.md" })).toBeNull();
  });

  it("applies a global Claude deny to native operations", () => {
    const check = createClaudeOperationPolicyChecker(parseClaudeOperationRules('{"permissions":{"deny":["*"]}}'));
    expect(check({ tool: "read", path: "README.md" })).toBe("*");
    expect(check({ tool: "grep", path: ".", pattern: "TODO" })).toBe("*");
    expect(check({ tool: "find", path: ".", pattern: "*.ts" })).toBe("*");
    expect(check({ tool: "ls", path: "." })).toBe("*");
  });

  it("applies bare Read, Grep, and Glob denies to all corresponding native uses", () => {
    const check = createClaudeOperationPolicyChecker(parseClaudeOperationRules(
      '{"permissions":{"deny":["Read","Grep","Glob"]}}',
    ));
    expect(check({ tool: "read", path: "README.md" })).toBe("*");
    expect(check({ tool: "ls", path: "." })).toBe("*");
    expect(check({ tool: "grep", path: "src", pattern: "TODO" })).toBe("*");
    expect(check({ tool: "find", path: ".", pattern: "*.ts" })).toBe("*");
  });

  it("mirrors Claude's broad bare Read rule for native search operations", () => {
    const check = createClaudeOperationPolicyChecker(parseClaudeOperationRules(
      '{"permissions":{"deny":["Read"]}}',
    ));
    expect(check({ tool: "grep", path: "src", pattern: "TODO" })).toBe("*");
    expect(check({ tool: "find", path: ".", pattern: "*.ts" })).toBe("*");
  });
});

describe("createClaudePolicyChecker — glob semantics", () => {
  const check = (pattern: string) => createClaudePolicyChecker([{ pattern, action: "deny" }]);

  it("the space before * is significant: `ls *` matches `ls -la` but not `lsof`", () => {
    const c = check("ls *");
    expect(c("ls -la")).toBe("ls *");
    expect(c("lsof")).toBe(null);
    expect(c("lsof -i")).toBe(null);
  });

  it("a trailing ` *` makes the arguments optional, so `ls *` also matches bare `ls`", () => {
    // Docs: the boundary requires the prefix to be followed by "a space or
    // end-of-string". Compiling this as `^ls .*$` misses bare `ls`, and a
    // missed deny is a command predexec runs that the host would have blocked.
    expect(check("ls *")("ls")).toBe("ls *");
    expect(check("npm test *")("npm test")).toBe("npm test *");
  });

  it("without the space, `ls*` matches both `ls -la` and `lsof`", () => {
    const c = check("ls*");
    expect(c("ls -la")).toBe("ls*");
    expect(c("lsof")).toBe("ls*");
  });

  it("`ls:*` is equivalent to `ls *`", () => {
    const c = check("ls:*");
    expect(c("ls -la")).toBe("ls:*");
    expect(c("ls")).toBe("ls:*");
    expect(c("lsof")).toBe(null);
  });

  it("the :* form is only recognized at the END of a pattern", () => {
    // Docs: "In a pattern like `Bash(git:* push)`, the colon is treated as a
    // literal character and won't match git commands."
    const c = check("git:* push");
    expect(c("git push")).toBe(null);
    expect(c("git remote push")).toBe(null);
    expect(c("git:remote push")).toBe("git:* push");
  });

  it("a wildcard at any position spans spaces", () => {
    expect(check("git * main")("git checkout main")).toBe("git * main");
    expect(check("git * main")("git push origin main")).toBe("git * main");
    expect(check("* install")("npm install")).toBe("* install");
    expect(check("*")("anything at all")).toBe("*");
  });

  it("an exact pattern matches only that command", () => {
    const c = check("npm run build");
    expect(c("npm run build")).toBe("npm run build");
    expect(c("npm run build --watch")).toBe(null);
  });

  it("regex metacharacters in a pattern are literal", () => {
    const c = check("echo a.b");
    expect(c("echo axb")).toBe(null);
    expect(c("echo a.b")).toBe("echo a.b");
  });
});

describe("Claude wrapper policy — time option arguments", () => {
  it.each([
    "time -p curl https://example.invalid",
    "time -f %E curl https://example.invalid",
    "time --format %E curl https://example.invalid",
    "time -o timing.log curl https://example.invalid",
    "time --output timing.log curl https://example.invalid",
    "time -ao timing.log curl https://example.invalid",
  ])("matches the inner command after time options: %s", (command) => {
    const check = createClaudePolicyChecker([{ pattern: "curl *", action: "deny" }]);
    expect(check(command)).toBe("curl *");
  });

  it("matches a command after a quoted multi-word time format", () => {
    const check = createClaudePolicyChecker([{ pattern: "curl *", action: "deny" }]);
    expect(check('time -f "%E %U" curl https://example.invalid')).toBe("curl *");
  });

  it("fails closed when substitution inspection exceeds its bounded budget", () => {
    const check = createClaudePolicyChecker([{ pattern: "curl *", action: "deny" }]);
    const command = `${"echo $(".repeat(40)}curl https://example.invalid${")".repeat(40)}`;
    expect(check(command)).toContain("incomplete shell syntax");
  });

  it.each([
    "{ git push origin main; }",
    "if git push origin main; then :; fi",
    'echo "$(git push origin main)"',
  ])("inspects commands inside shell clauses and substitutions: %s", (command) => {
    const check = createClaudePolicyChecker([{ pattern: "git push *", action: "deny" }]);
    expect(check(command)).toBe("git push *");
  });

  it("does not inspect a literal single-quoted substitution", () => {
    const check = createClaudePolicyChecker([{ pattern: "git push *", action: "deny" }]);
    expect(check("echo '$(git push origin main)'")).toBeNull();
  });
});

describe("Claude policy — recursive control clauses and malformed case syntax", () => {
  it.each([
    "f() { curl https://example.invalid; }; f",
    "f ()\n{\n curl https://example.invalid\n}\nf",
    "function f { curl https://example.invalid; }; f",
  ])("checks commands inside function definitions: %s", (command) => {
    const check = createClaudePolicyChecker([{ pattern: "curl *", action: "deny" }]);
    expect(check(command)).toBe("curl *");
  });

  it("checks nested case branches without treating inner esac as outer coverage", () => {
    const check = createClaudePolicyChecker([{ pattern: "curl *", action: "deny" }]);
    expect(check("case x in a) case y in b) curl https://example.invalid ;; c) echo ok ;; esac ;; d) printf ok ;; esac")).toBe("curl *");
  });

  it("checks functions in nested cases and suffix commands", () => {
    const check = createClaudePolicyChecker([{ pattern: "touch *", action: "deny" }]);
    expect(check("case x in a) case y in b) f(){ touch /tmp/x; }; f ;; esac ;; esac")).toBe("touch *");
    expect(check("case x in a) echo ok ;; esac; touch /tmp/x")).toBe("touch *");
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
    const check = createClaudePolicyChecker([{ pattern: "mkdir *", action: "deny" }]);
    expect(check(command)).toBe("mkdir *");
  });

  it.each([
    "(curl https://example.invalid)",
    "! (curl https://example.invalid)",
    "if (curl https://example.invalid); then :; fi",
    "case x in a) (curl https://example.invalid) ;; esac",
    "if (while true; do (curl https://example.invalid); done); then :; fi",
  ])("checks denied commands at every control depth: %s", (command) => {
    const check = createClaudePolicyChecker([{ pattern: "curl *", action: "deny" }]);
    expect(check(command)).toBe("curl *");
  });

  it.each([
    "case x in a) echo first b) echo second ;; esac",
    "case x in a) echo first ;; b) echo second c) echo third ;; esac",
    "case x in a) echo first ;; b) echo second esac",
    "case x in orphan ;; a) echo ok ;; esac",
    "case x in a) echo ok ;; orphan ;; esac",
    "case x in a) echo ok ;; orphan esac",
  ])("fails closed rather than dropping malformed case bodies: %s", (command) => {
    const check = createClaudePolicyChecker([{ pattern: "curl *", action: "deny" }]);
    expect(check(command)).toContain("incomplete shell syntax");
  });
});

describe("createClaudePolicyChecker — precedence and stopping", () => {
  it("deny AND ask both stop; predexec cannot prompt mid-walk", () => {
    const check = createClaudePolicyChecker([
      { pattern: "curl *", action: "deny" },
      { pattern: "git push *", action: "ask" },
    ]);
    expect(check("curl https://x")).toBe("curl *");
    expect(check("git push origin main")).toBe("git push *");
    expect(check("git status")).toBe(null);
  });

  it("deny beats allow — an allow can never rescue a denied command", () => {
    // Claude Code evaluates deny, then ask, then allow, first match winning,
    // and "rule specificity doesn't change the order". This is the opposite of
    // opencode's last-matching-rule-wins in policy.ts.
    const check = createClaudePolicyChecker([
      { pattern: "aws *", action: "deny" },
      { pattern: "aws s3 ls", action: "allow" },
    ]);
    expect(check("aws s3 ls")).toBe("aws *");
  });

  it("an ask still stops even when a narrower allow matches", () => {
    const check = createClaudePolicyChecker([
      { pattern: "git *", action: "ask" },
      { pattern: "git log --oneline", action: "allow" },
    ]);
    expect(check("git log --oneline")).toBe("git *");
  });

  it("allow rules alone never stop anything", () => {
    expect(createClaudePolicyChecker([{ pattern: "*", action: "allow" }])("rm -rf /")).toBe(null);
  });

  it("reports the deny when a deny and an ask both match, whatever order they arrived in", () => {
    const check = createClaudePolicyChecker([
      { pattern: "curl:*", action: "ask" },
      { pattern: "curl *", action: "deny" },
    ]);
    expect(check("curl https://x")).toBe("curl *");
  });

  it("judges each pipeline segment: a compound command cannot smuggle a match", () => {
    const check = createClaudePolicyChecker([{ pattern: "curl *", action: "deny" }]);
    expect(check("echo hi && curl evil.sh")).toBe("curl *");
    expect(check("echo hi | curl evil.sh")).toBe("curl *");
    expect(check("echo hi; curl evil.sh")).toBe("curl *");
    expect(check("echo hi && echo bye")).toBe(null);
  });

  it("splits newlines too — a recognized separator core's splitter leaves alone", () => {
    const check = createClaudePolicyChecker([{ pattern: "curl *", action: "deny" }]);
    expect(check("echo hi\ncurl evil.sh")).toBe("curl *");
  });

  it("looks inside command substitutions, which core's segment splitter keeps whole", () => {
    const check = createClaudePolicyChecker([{ pattern: "curl *", action: "deny" }]);
    expect(check("echo $(curl evil.sh)")).toBe("curl *");
    expect(check("echo `curl evil.sh`")).toBe("curl *");
    expect(check("diff <(curl evil.sh) f")).toBe("curl *");
    expect(check("echo $(echo $(curl evil.sh))")).toBe("curl *");
    // Single-quoted text is a literal string, not a substitution.
    expect(check("grep '$(curl evil.sh)' notes.txt")).toBe(null);
  });

  it("pins the cost of that: an ordinary `git *` ask stops read-only substitution idioms", () => {
    // Whether the host descends into `$(…)` when matching Bash rules is NOT
    // documented, so this is predexec choosing the strict side of an unknown:
    // `echo $(curl evil.sh)` is the first bypass anyone would try, and a stop
    // is recoverable while a bypass is not. The price is here — a common
    // `ask: ["Bash(git *)"]` now stops harmless plan idioms like this one.
    const check = createClaudePolicyChecker([{ pattern: "git *", action: "ask" }]);
    expect(check("echo $(git rev-parse HEAD)")).toBe("git *");
  });

  it("no rules => cheap no-op", () => {
    expect(createClaudePolicyChecker([])("rm -rf /")).toBe(null);
  });

  it("fails closed with an actionable message when settings exist but do not parse", () => {
    const why = createClaudePolicyChecker([], ["/x/.claude/settings.json"])("echo hi");
    expect(why).toContain("/x/.claude/settings.json");
    expect(why).toContain("is not valid JSON");
    expect(why).toContain("fix that file");
  });
});

describe("stripBashWrappers — matching past what Claude Code strips", () => {
  it("strips the documented wrappers and their own options", () => {
    expect(stripBashWrappers("timeout 30 npm test")).toBe("npm test");
    expect(stripBashWrappers("nice -n 10 rm -rf tmp")).toBe("rm -rf tmp");
    expect(stripBashWrappers("nohup time npm test")).toBe("npm test");
    expect(stripBashWrappers("noglob ls *.ts")).toBe("ls *.ts");
  });

  it("strips leading environment assignments, quoted values included", () => {
    expect(stripBashWrappers("FOO=bar rm -rf tmp/")).toBe("rm -rf tmp/");
    expect(stripBashWrappers('FOO="a b" NODE_ENV=test npm test')).toBe("npm test");
  });

  it("strips bare xargs/command but not their flagged query forms", () => {
    expect(stripBashWrappers("xargs grep pattern")).toBe("grep pattern");
    // `xargs -n1 grep` is matched as an xargs command by the host, and
    // `command -v` looks a command up rather than running it.
    expect(stripBashWrappers("xargs -n1 grep pattern")).toBe("xargs -n1 grep pattern");
    expect(stripBashWrappers("command -v rg")).toBe("command -v rg");
  });

  it("leaves environment runners alone — they are not on the host's list", () => {
    expect(stripBashWrappers("npx tsc --noEmit")).toBe("npx tsc --noEmit");
    expect(stripBashWrappers("docker exec c rm -rf /")).toBe("docker exec c rm -rf /");
  });

  it("returns a plain command unchanged", () => {
    expect(stripBashWrappers("git status")).toBe("git status");
    expect(stripBashWrappers("")).toBe("");
  });

  it("a wrapped command is still caught by a rule for the inner command", () => {
    // Without the strip, `deny: ["Bash(rm *)"]` misses `timeout 5 rm -rf tmp`
    // and predexec runs a command the host blocks — less conservative than the
    // host, which is the whole failure mode this module exists to prevent.
    const check = createClaudePolicyChecker([{ pattern: "rm *", action: "deny" }]);
    expect(check("timeout 5 rm -rf tmp")).toBe("rm *");
    expect(check("FOO=bar rm -rf tmp/")).toBe("rm *");
  });

  it("and the wrapper's own rule still matches the unstripped form", () => {
    // Matching only the stripped form would miss this one, hence the union.
    const check = createClaudePolicyChecker([{ pattern: "timeout *", action: "deny" }]);
    expect(check("timeout 30 npm test")).toBe("timeout *");
  });
});

describe("readClaudeBashRules — settings discovery", () => {
  let tmp: string;
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  const setup = () => {
    tmp = mkdtempSync(join(tmpdir(), "px-claude-policy-"));
    const repo = join(tmp, "repo");
    const home = join(tmp, "home", ".claude");
    const managed = join(tmp, "managed");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(managed, { recursive: true });
    const opts = { env: { CLAUDE_CONFIG_DIR: home } as NodeJS.ProcessEnv, managedDir: managed, home: join(tmp, "home") };
    return { repo, home, managed, opts };
  };

  const write = (path: string, deny: string[]) =>
    writeFileSync(path, JSON.stringify({ permissions: { deny: deny.map((d) => `Bash(${d})`) } }));

  it("lists remote → managed → local → project → user, in that order", () => {
    const { repo, home, managed, opts } = setup();
    mkdirSync(join(managed, "managed-settings.d"), { recursive: true });
    writeFileSync(join(managed, "managed-settings.d", "10-org.json"), "{}");
    expect(claudeSettingsPaths(repo, opts)).toEqual([
      join(home, "remote-settings.json"),
      join(managed, "managed-settings.json"),
      join(managed, "managed-settings.d", "10-org.json"),
      join(repo, ".claude", "settings.local.json"),
      join(repo, ".claude", "settings.json"),
      join(home, "settings.json"),
    ]);
  });

  it("unions deny/ask rules from every scope — a deny at any level stops us", () => {
    const { repo, home, managed, opts } = setup();
    write(join(managed, "managed-settings.json"), ["aws *"]);
    write(join(repo, ".claude", "settings.local.json"), ["curl *"]);
    write(join(repo, ".claude", "settings.json"), ["wget *"]);
    write(join(home, "settings.json"), ["ssh *"]);
    const { rules } = readClaudeBashRules(repo, opts);
    expect(rules.map((r) => r.pattern)).toEqual(["aws *", "curl *", "wget *", "ssh *"]);
  });

  it("a project allow does not widen a user-level deny", () => {
    const { repo, home, opts } = setup();
    write(join(home, "settings.json"), ["curl *"]);
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(curl *)"] } }),
    );
    const { rules, unreadable } = readClaudeBashRules(repo, opts);
    expect(createClaudePolicyChecker(rules, unreadable)("curl https://x")).toBe("curl *");
  });

  it("resolves settings.local.json from the git repository ROOT, not the cwd", () => {
    const { repo, opts } = setup();
    const nested = join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });
    write(join(repo, ".claude", "settings.local.json"), ["curl *"]);
    // Started in a subdirectory: the repo-root file must still be found.
    expect(claudeSettingsPaths(nested, opts)).toContain(join(repo, ".claude", "settings.local.json"));
    expect(readClaudeBashRules(nested, opts).rules).toEqual([{ pattern: "curl *", action: "deny" }]);
  });

  it("resolves a linked worktree back to the main checkout", () => {
    const { repo, opts } = setup();
    const worktree = join(tmp, "wt");
    mkdirSync(join(worktree, ".claude"), { recursive: true });
    // A linked worktree's `.git` is a FILE pointing into the main checkout.
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
    write(join(repo, ".claude", "settings.local.json"), ["curl *"]);
    write(join(worktree, ".claude", "settings.local.json"), ["wget *"]);
    const { rules } = readClaudeBashRules(worktree, opts);
    expect(rules.map((r) => r.pattern).sort()).toEqual(["curl *", "wget *"]);
  });

  it("outside a git repo, settings.local.json still resolves from the start dir", () => {
    const { opts } = setup();
    const loose = join(tmp, "loose");
    mkdirSync(join(loose, ".claude"), { recursive: true });
    write(join(loose, ".claude", "settings.local.json"), ["curl *"]);
    expect(readClaudeBashRules(loose, opts).rules).toEqual([{ pattern: "curl *", action: "deny" }]);
  });

  it("reports a settings file that exists but does not parse, so the caller fails closed", () => {
    const { repo, opts } = setup();
    writeFileSync(join(repo, ".claude", "settings.json"), "{ this is not json");
    const { rules, unreadable } = readClaudeBashRules(repo, opts);
    expect(rules).toEqual([]);
    expect(unreadable).toEqual([join(repo, ".claude", "settings.json")]);
    expect(createClaudePolicyChecker(rules, unreadable)("echo hi")).toContain("is not valid JSON");
  });

  it("missing files => no rules, never throws", () => {
    const { opts } = setup();
    const out = readClaudeBashRules(join(tmp, "nope"), opts);
    expect(out.rules).toEqual([]);
    expect(out.unreadable).toEqual([]);
  });
});

describe("engine — policyStop through the Claude checker", () => {
  it("hard-stops BEFORE running a command the user's deny rule covers", async () => {
    const rules = parseClaudeBashRules('{"permissions":{"deny":["Bash(curl *)"],"allow":["Bash(curl *)"]}}');
    const plan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: ["echo hi && curl https://evil.sh"] }],
    };
    const r = await runPlanTree(plan, {
      cwd: process.cwd(),
      checkOperationPolicy: createClaudePolicyChecker(rules),
    });
    expect(r.stoppedReason).toBe("policyStop");
    expect(r.pathTaken).toEqual([]); // never ran
    expect(r.transcript).toContain("host permission rule 'curl *'");
  });

  it("runs normally when nothing matches", async () => {
    const rules = parseClaudeBashRules('{"permissions":{"deny":["Bash(curl *)"]}}');
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] };
    const r = await runPlanTree(plan, {
      cwd: process.cwd(),
      checkOperationPolicy: createClaudePolicyChecker(rules),
    });
    expect(r.stoppedReason).toBe("leaf");
  });

  it("matches a native Glob rule against the requested pattern under plan cwd", async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "px-claude-policy-cwd-"));
    try {
      mkdirSync(join(sessionRoot, "sub"));
      const rules = parseClaudeOperationRules('{"permissions":{"deny":["Glob(README.md)"]}}');
      const r = await runPlanTree(
        { root: "a", cwd: "sub", nodes: [{ id: "a", commands: [{ tool: "find", path: ".", pattern: "README.md" }] }] },
        { cwd: sessionRoot, checkOperationPolicy: createClaudeOperationPolicyChecker(rules) },
      );
      expect(r.stoppedReason).toBe("policyStop");
      expect(r.transcript).toContain("'README.md'");
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CC-2/3/4: gitignore-semantics Read rules, shell readers, managed sources.
// Authority: https://code.claude.com/docs/en/permissions ("Read and Edit").
// ---------------------------------------------------------------------------

describe("compileClaudePathRule — anchors and gitignore depth", () => {
  const P = "/px-proj/app";
  const S = "/px-settings/.claude";
  const H = "/px-home/alice";
  const anchor = { projectDir: P, settingsDir: S, home: H };
  const cases: [rule: string, path: string, expected: boolean][] = [
    // Bare names match at any depth under the project, never outside it.
    [".env", `${P}/.env`, true],
    [".env", `${P}/config/.env`, true],
    [".env", `/elsewhere/.env`, false],
    // A single-segment `dir/**` deny matches that directory at any depth.
    ["secrets/**", `${P}/lib/secrets/x`, true],
    ["secrets/**", `${P}/secrets/a/b`, true],
    // Every other shape matches only at its anchored location.
    ["src/components/**", `${P}/vendor/src/components/a`, false],
    ["src/components/**", `${P}/src/components/a`, true],
    // `//` is filesystem-absolute.
    ["//etc/**", "/etc/hosts", true],
    ["//**/.env", "/any/where/.env", true],
    // `~/` is home-relative.
    ["~/.ssh/**", `${H}/.ssh/id_rsa`, true],
    ["~/.ssh/**", `${P}/.ssh/id_rsa`, false],
    // `/` anchors at the settings source, NOT the filesystem root.
    ["/x/**", `${S}/x/y`, true],
    ["/x/**", `${P}/x/y`, false],
    ["/x/**", "/x/y", false],
    // `./` anchors at the project directory.
    ["./.env", `${P}/.env`, true],
    ["./.env", `${P}/sub/.env`, false],
  ];
  it.each(cases)("Read(%s) vs %s → %s", (rule, path, expected) => {
    expect(compileClaudePathRule(rule, anchor)(path)).toBe(expected);
  });

  it("a deny written through a symlinked directory also applies at its real location", () => {
    // realpath the temp root so only `link` is a symlink (macOS /var → /private/var).
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "px-claude-real-")));
    try {
      mkdirSync(join(tmp, "real"));
      symlinkSync(join(tmp, "real"), join(tmp, "link"));
      const match = compileClaudePathRule(`/${join(tmp, "link")}/**`, anchor);
      expect(match(join(tmp, "real", "secret"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Claude Read rules — tool ops and shell readers", () => {
  let tmp: string;
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  const setup = (permissions: Record<string, string[]>) => {
    tmp = mkdtempSync(join(tmpdir(), "px-claude-read-"));
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    const configDir = join(home, ".claude");
    const managed = join(tmp, "managed");
    for (const dir of [join(repo, ".claude"), join(repo, ".git"), join(repo, "secrets"), join(repo, "lib", "secrets"), join(repo, "src"), configDir, managed]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(repo, ".env"), "TOKEN=1\n");
    writeFileSync(join(repo, "README.md"), "hello\n");
    writeFileSync(join(repo, "secrets", "k.pem"), "k\n");
    writeFileSync(join(repo, "lib", "secrets", "x"), "x\n");
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ permissions }));
    const opts = {
      env: { CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv,
      managedDir: managed,
      home,
      managedPolicySources: () => [],
    };
    const check = createClaudeHostPolicyChecker(repo, opts);
    const ctx = { cwd: repo, sessionRoot: repo };
    return { repo, home, configDir, opts, check, ctx };
  };

  const run = (repo: string, check: ReturnType<typeof createClaudeHostPolicyChecker>, commands: PlanTree["nodes"][number]["commands"]) =>
    runPlanTree({ root: "a", nodes: [{ id: "a", commands }] }, { cwd: repo, checkOperationPolicy: check });

  it("Read(.env) denies a nested config/.env (bare names match at any depth)", () => {
    const { check, ctx, repo } = setup({ deny: ["Read(.env)"] });
    mkdirSync(join(repo, "config"));
    writeFileSync(join(repo, "config", ".env"), "");
    expect(check({ tool: "read", path: "config/.env" }, ctx)).toBe(".env");
    expect(check({ tool: "read", path: "README.md" }, ctx)).toBeNull();
  });

  it("Read(secrets/**) denies lib/secrets/x", () => {
    const { check, ctx } = setup({ deny: ["Read(secrets/**)"] });
    expect(check({ tool: "read", path: "lib/secrets/x" }, ctx)).toBe("secrets/**");
  });

  it("Read(//abs/**) and Read(~/...) deny absolute and home paths", () => {
    const { check, ctx, home } = setup({ deny: [`Read(/${join(tmpdir(), "px-nowhere")}/**)`, "Read(~/.ssh/**)"] });
    expect(check({ tool: "read", path: join(tmpdir(), "px-nowhere", "f") }, ctx)).not.toBeNull();
    expect(check({ tool: "read", path: join(home, ".ssh", "id_rsa") }, ctx)).toBe("~/.ssh/**");
  });

  it("normalizes the operation path: Read(./.env) denies a/../.env", () => {
    const { check, ctx } = setup({ deny: ["Read(./.env)"] });
    expect(check({ tool: "read", path: "a/../.env" }, ctx)).toBe("./.env");
  });

  it("checks a symlink's target: link -> .env is denied", () => {
    const { check, ctx, repo } = setup({ deny: ["Read(./.env)"] });
    symlinkSync(join(repo, ".env"), join(repo, "link"));
    expect(check({ tool: "read", path: "link" }, ctx)).toBe("./.env");
  });

  it("applies Read rules to the directory grep/find/ls search", () => {
    const { check, ctx } = setup({ deny: ["Read(secrets/**)"] });
    expect(check({ tool: "grep", path: "secrets", pattern: "k" }, ctx)).toBe("secrets/**");
    expect(check({ tool: "find", path: "secrets", pattern: "*.pem" }, ctx)).toBe("secrets/**");
    expect(check({ tool: "ls", path: "secrets" }, ctx)).toBe("secrets/**");
    expect(check({ tool: "grep", path: "src", pattern: "k" }, ctx)).toBeNull();
  });

  it("a file-name rule does not make a whole-tree search a read of that file", () => {
    const { check, ctx } = setup({ deny: ["Read(.env)"] });
    expect(check({ tool: "grep", path: ".", pattern: "x" }, ctx)).toBeNull();
    expect(check({ tool: "find", path: ".", pattern: "*.md" }, ctx)).toBeNull();
  });

  it("honors ordered `!` carve-outs within one settings file only", () => {
    const { check, ctx } = setup({ deny: ["Read(*.pem)", "Read(!k.pem)", "Read(*.key)"] });
    expect(check({ tool: "read", path: "secrets/k.pem" }, ctx)).toBeNull();
    expect(check({ tool: "read", path: "secrets/other.pem" }, ctx)).toBe("*.pem");
    expect(check({ tool: "read", path: "a.key" }, ctx)).toBe("*.key");
  });

  it("a carve-out in one file does not cancel a deny from another file", () => {
    const { repo, configDir, opts, ctx } = setup({ deny: ["Read(!k.pem)"] });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ permissions: { deny: ["Read(//**/*.pem)"] } }));
    const check = createClaudeHostPolicyChecker(repo, opts);
    expect(check({ tool: "read", path: "secrets/k.pem" }, ctx)).toBe("//**/*.pem");
  });

  it.each([
    ["cat .env"],
    ["head .env"],
    ["cat < .env"],
    ["tail -n1 ./.env"],
    ["grep TOKEN .env"],
    ["sed -n 1p .env"],
    ["cat .en*"],
    ["wc -l README.md && cat .env"],
    ["timeout 5 cat .env"],
    ["while read l; do echo $l; done < .env"],
  ])("Read(./.env) deny hard-stops the shell read `%s`", async (command) => {
    const { repo, check } = setup({ deny: ["Read(./.env)"] });
    const r = await run(repo, check, [command]);
    expect(r.stoppedReason).toBe("policyStop");
    expect(r.pathTaken).toEqual([]);
  });

  it.each([
    ["cat README.md"],
    ["grep .env README.md"],
    ["echo hi 2>&1"],
    ["awk '{print $1}' README.md"],
  ])("a Read(./.env) deny still runs the unrelated shell read `%s`", async (command) => {
    const { repo, check } = setup({ deny: ["Read(./.env)"] });
    const r = await run(repo, check, [command]);
    expect(r.stoppedReason).toBe("leaf");
  });

  it("stops a reader operand it cannot resolve (shell expansion)", async () => {
    const { repo, check } = setup({ deny: ["Read(./.env)"] });
    const r = await run(repo, check, ["F=.env; cat $F"]);
    expect(r.stoppedReason).toBe("policyStop");
  });

  it("no Read rules => shell readers are not inspected", async () => {
    const { repo, check } = setup({});
    expect((await run(repo, check, ["cat $HOME/x || true"])).stoppedReason).not.toBe("policyStop");
  });

  it("honors a rule placed only in the remote-settings cache", async () => {
    const { repo, configDir, opts, ctx } = setup({});
    writeFileSync(
      join(configDir, "remote-settings.json"),
      JSON.stringify({ permissions: { deny: ["Read(./.env)", "Bash(curl *)"] } }),
    );
    const check = createClaudeHostPolicyChecker(repo, opts);
    expect(check({ tool: "read", path: ".env" }, ctx)).toBe("./.env");
    expect(check("curl https://x", ctx)).toBe("curl *");
    expect(check("cat .env", ctx)).toBe("./.env");
  });
});

describe("Claude settings sources — CLAUDE_CONFIG_DIR and managed policy", () => {
  it("CLAUDE_CONFIG_DIR relocates the user settings and remote cache", () => {
    const paths = claudeSettingsPaths("/px-proj", {
      env: { CLAUDE_CONFIG_DIR: "/px-cfg" } as NodeJS.ProcessEnv,
      managedDir: "/px-managed",
      home: "/px-home",
    });
    expect(paths).toContain(join("/px-cfg", "settings.json"));
    expect(paths).toContain(join("/px-cfg", "remote-settings.json"));
    expect(paths).not.toContain(join("/px-home", ".claude", "settings.json"));
    const unset = claudeSettingsPaths("/px-proj", { env: {}, managedDir: "/px-managed", home: "/px-home" });
    expect(unset).toContain(join("/px-home", ".claude", "settings.json"));
    expect(unset).toContain(join("/px-home", ".claude", "remote-settings.json"));
  });

  it("detects a macOS MDM plist by presence, device-wide or per-user", () => {
    const tmp = mkdtempSync(join(tmpdir(), "px-claude-mdm-"));
    try {
      expect(detectManagedPolicySources({ platform: "darwin", managedPreferencesDir: tmp, user: "alice" })).toEqual([]);
      mkdirSync(join(tmp, "alice"));
      writeFileSync(join(tmp, "alice", "com.anthropic.claudecode.plist"), "bplist00");
      expect(detectManagedPolicySources({ platform: "darwin", managedPreferencesDir: tmp, user: "alice" })).toEqual([
        join(tmp, "alice", "com.anthropic.claudecode.plist"),
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects a Windows registry policy by presence and skips other platforms", () => {
    const seen: string[] = [];
    const found = detectManagedPolicySources({
      platform: "win32",
      registryHasValue: (key) => {
        seen.push(key);
        return key.startsWith("HKCU");
      },
    });
    expect(seen).toEqual(["HKLM\\SOFTWARE\\Policies\\ClaudeCode", "HKCU\\SOFTWARE\\Policies\\ClaudeCode"]);
    expect(found).toEqual(["HKCU\\SOFTWARE\\Policies\\ClaudeCode"]);
    expect(detectManagedPolicySources({ platform: "linux" })).toEqual([]);
  });

  it("fails closed on every operation when an unreadable managed policy is present", () => {
    const check = createClaudeHostPolicyChecker("/px-proj", {
      env: {},
      managedDir: "/px-managed-none",
      home: "/px-home-none",
      managedPolicySources: () => ["/Library/Managed Preferences/com.anthropic.claudecode.plist"],
    });
    const ctx = { cwd: "/px-proj", sessionRoot: "/px-proj" };
    for (const op of ["echo hi", { tool: "read", path: "README.md" }, { tool: "bash", command: "ls" }] as const) {
      expect(check(op, ctx)).toMatch(/managed MDM policy .* cannot be read by predexec/);
    }
  });
});
