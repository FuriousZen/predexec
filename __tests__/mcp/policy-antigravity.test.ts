import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAntigravityPolicyChecker,
  parseAntigravityGrant,
  resolveAntigravityRoot,
} from "../../mcp/policy-antigravity.ts";
import { runPlanTree } from "../../core/engine.ts";
import type { Operation, PolicyCheckContext } from "../../core/types.ts";

let tmp: string;
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

/** A fresh `<tmp>/home` + `<tmp>/ws` pair — the real `~/.gemini` is never read. */
function setup(settings?: unknown) {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "px-agy-policy-")));
  const home = join(tmp, "home");
  const ws = join(tmp, "ws");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  mkdirSync(ws, { recursive: true });
  if (settings !== undefined) {
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      typeof settings === "string" ? settings : JSON.stringify(settings),
    );
  }
  return { home, ws };
}

function checker(settings?: unknown) {
  const { home, ws } = setup(settings);
  const check = createAntigravityPolicyChecker({ home, cwd: ws, env: {} });
  const ctx: PolicyCheckContext = { cwd: ws, sessionRoot: ws };
  return { ws, home, run: (op: Operation, extra: Partial<PolicyCheckContext> = {}) => check(op, { ...ctx, ...extra }) };
}

describe("parseAntigravityGrant", () => {
  it("parses prefix, regex and wildcard targets", () => {
    expect(parseAntigravityGrant("command(git status)")).toEqual({
      action: "command",
      target: { kind: "prefix", value: "git status" },
    });
    expect(parseAntigravityGrant("command(regex:git .*)")).toEqual({
      action: "command",
      target: { kind: "regex", value: "git .*" },
    });
    expect(parseAntigravityGrant("read_file(*)")).toEqual({ action: "read_file", target: { kind: "any", value: "*" } });
    expect(parseAntigravityGrant("mcp(server/*)")).toEqual({
      action: "mcp",
      target: { kind: "prefix", value: "server/*" },
    });
  });

  it("returns null for anything that is not action(target)", () => {
    expect(parseAntigravityGrant("git status")).toBeNull();
    expect(parseAntigravityGrant("command()")).toBeNull();
    expect(parseAntigravityGrant("command(git")).toBeNull();
    expect(parseAntigravityGrant("Command(git)")).toBeNull();
    expect(parseAntigravityGrant("")).toBeNull();
  });
});

describe("antigravity policy — command grants", () => {
  it("a missing settings file allows everything", async () => {
    const { run } = checker();
    expect(await run("git status")).toBeNull();
    expect(await run({ tool: "read", path: "x.txt" })).toBeNull();
  });

  it("deny stops; deny beats an allow for the same command", async () => {
    const { run } = checker({ permissions: { allow: ["command(git)"], deny: ["command(git log)"] } });
    expect(await run("git log -1")).toMatch(/command\(git log\)/);
    expect(await run("git status")).toBeNull();
  });

  it("ask stops (predexec cannot prompt mid-walk), even over an allow", async () => {
    const { run } = checker({ permissions: { allow: ["command(cat)"], ask: ["command(cat)"] } });
    expect(await run("cat a.txt")).toMatch(/ask.*command\(cat\)/);
  });

  it("prefix matching is on a word boundary: command(git) matches `git status`, not `gitk`", async () => {
    const { run } = checker({ permissions: { deny: ["command(git)"] } });
    expect(await run("git status")).not.toBeNull();
    expect(await run("git")).not.toBeNull();
    expect(await run("gitk --all")).toBeNull();
  });

  it("every pipeline/chain segment is judged, and transparent wrappers do not hide the head", async () => {
    const { run } = checker({ permissions: { deny: ["command(cat)"] } });
    expect(await run("echo hi && cat x")).not.toBeNull();
    expect(await run("ls | cat")).not.toBeNull();
    expect(await run("timeout 5 cat x")).not.toBeNull();
    expect(await run("FOO=1 cat x")).not.toBeNull();
    expect(await run("/bin/cat x")).not.toBeNull();
    expect(await run("ca\\\nt x")).not.toBeNull();
  });

  it("command(*) matches every command", async () => {
    const { run } = checker({ permissions: { ask: ["command(*)"] } });
    expect(await run("ls")).not.toBeNull();
  });

  it("regex: grants are anchored per token and prefix-match by token", async () => {
    const { run } = checker({ permissions: { deny: ["command(regex:git (log|show))"] } });
    expect(await run("git log -1")).not.toBeNull();
    expect(await run("git show HEAD")).not.toBeNull();
    expect(await run("git status")).toBeNull();
    // anchored: `logs` is not `log`
    expect(await run("git logs")).toBeNull();
  });

  it("an unsafe regex: deny grant fails closed (stops every shell command)", async () => {
    const { run } = checker({ permissions: { deny: ["command(regex:(a+)+)"] } });
    expect(await run("ls")).toMatch(/regex/);
    // it is a command grant, so tool ops are unaffected
    expect(await run({ tool: "read", path: "x" })).toBeNull();
  });

  it("an unsafe regex: allow grant is ignored (only adds stops under strict)", async () => {
    const { run } = checker({ toolPermission: "strict", permissions: { allow: ["command(regex:(a+)+)", "command(ls)"] } });
    expect(await run("ls")).toBeNull();
    expect(await run("aaa")).not.toBeNull();
  });

  it("deny/ask still see through command substitution", async () => {
    const { run } = checker({ permissions: { deny: ["command(cat)"] } });
    expect(await run("echo $(cat secret)")).not.toBeNull();
    expect(await run("echo `cat secret`")).not.toBeNull();
  });

  it("a substitution construct needs an exact full-line allow (prefix allows do not cover it)", async () => {
    const { run } = checker({
      toolPermission: "strict",
      permissions: { allow: ["command(echo)", "command(echo $(date))"] },
    });
    expect(await run("echo hi")).toBeNull();
    expect(await run("echo $(date)")).toBeNull();
    expect(await run("echo $(whoami)")).toMatch(/strict/);
    expect(await run("echo `date`")).toMatch(/strict/);
    expect(await run("diff <(echo a) b")).toMatch(/strict/);
  });

  it("strict: a command stops unless every segment matches an allow", async () => {
    const { run } = checker({ toolPermission: "strict", permissions: { allow: ["command(git status)", "command(ls)"] } });
    expect(await run("git status")).toBeNull();
    expect(await run("timeout 5 git status")).toBeNull();
    expect(await run("git status && ls")).toBeNull();
    expect(await run("git status && pwd")).toMatch(/strict/);
    expect(await run("pwd")).toMatch(/strict/);
  });

  it("strict does not re-demand an allow for an engine variant of an already-allowed operation", async () => {
    const { run } = checker({ toolPermission: "strict", permissions: { allow: ["command(sh)"], deny: ["command(cat)"] } });
    expect(await run("ls", { variant: true })).toBeNull();
    // ...but deny still applies to variants
    expect(await run("cat x", { variant: true })).not.toBeNull();
  });

  it("non-strict modes need no allow", async () => {
    for (const toolPermission of ["always-proceed", "request-review"]) {
      const { run } = checker({ toolPermission });
      expect(await run("pwd")).toBeNull();
    }
  });

  it("an unknown toolPermission value is treated as strict (fail closed)", async () => {
    const { run } = checker({ toolPermission: "future-mode" });
    expect(await run("pwd")).toMatch(/strict|toolPermission/);
  });

  it("{tool:'bash'} operations are shell commands", async () => {
    const { run } = checker({ permissions: { deny: ["command(cat)"] } });
    expect(await run({ tool: "bash", command: "cat x" })).not.toBeNull();
  });
});

describe("antigravity policy — read_file grants and tool ops", () => {
  it("a read_file deny applies to read/grep/find/ls tool ops, recursively below a directory", async () => {
    const { run } = checker({ permissions: { deny: ["read_file(secrets)"] } });
    expect(await run({ tool: "read", path: "secrets/key.txt" })).toMatch(/read_file\(secrets\)/);
    expect(await run({ tool: "grep", pattern: "x", path: "secrets" })).not.toBeNull();
    expect(await run({ tool: "find", pattern: "*", path: "secrets/sub" })).not.toBeNull();
    expect(await run({ tool: "ls", path: "secrets" })).not.toBeNull();
    expect(await run({ tool: "read", path: "secretsx/a" })).toBeNull();
    expect(await run({ tool: "read", path: "README.md" })).toBeNull();
  });

  it("a read_file deny with an absolute path matches", async () => {
    const { ws, home } = setup();
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ permissions: { deny: [`read_file(${join(ws, ".env")})`] } }),
    );
    const check = createAntigravityPolicyChecker({ home, cwd: ws, env: {} });
    expect(await check({ tool: "read", path: ".env" }, { cwd: ws, sessionRoot: ws })).not.toBeNull();
  });

  it("a tool op with no path targets the node cwd", async () => {
    const { run, ws } = checker({ permissions: { deny: ["read_file(sub)"] } });
    expect(await run({ tool: "ls" }, { cwd: join(ws, "sub") })).not.toBeNull();
    expect(await run({ tool: "ls" }, { cwd: join(ws, "other") })).toBeNull();
  });

  it("a read_file deny also stops grep/find/ls rooted ABOVE the denied path (they would read inside it)", async () => {
    const { run } = checker({ permissions: { deny: ["read_file(.env)"], ask: ["read_file(secrets/deep)"] } });
    expect(await run({ tool: "grep", pattern: "KEY", path: "." })).toMatch(/read_file\(\.env\)/);
    expect(await run({ tool: "grep", pattern: "KEY" })).toMatch(/read_file\(\.env\)/);
    expect(await run({ tool: "find", pattern: "*", path: "." })).not.toBeNull();
    expect(await run({ tool: "ls", path: "." })).not.toBeNull();
    expect(await run({ tool: "grep", pattern: "x", path: "secrets" })).toMatch(/secrets\/deep/);
    // a search that cannot reach the denied path is fine
    expect(await run({ tool: "grep", pattern: "KEY", path: "src" })).toBeNull();
    // a plain read of an ancestor dir's sibling file is not a read of the denied file
    expect(await run({ tool: "read", path: "README.md" })).toBeNull();
  });

  it("a read_file target containing $ (an env var) is unknown syntax: fails closed in deny, ignored in allow", async () => {
    expect(await checker({ permissions: { deny: ["read_file($HOME/.ssh)"] } }).run({ tool: "read", path: "a" })).not.toBeNull();
    expect(
      await checker({ toolPermission: "strict", permissions: { allow: ["read_file($PWD)", "read_file(a)"] } }).run({
        tool: "read",
        path: "a",
      }),
    ).toBeNull();
  });

  it("read_file ask stops; read_file(*) matches everything", async () => {
    const { run } = checker({ permissions: { ask: ["read_file(*)"] } });
    expect(await run({ tool: "read", path: "a" })).not.toBeNull();
  });

  it("command grants do not touch tool ops; read_file grants reach shell path operands (E-E)", async () => {
    const { run } = checker({ permissions: { deny: ["command(cat)", "read_file(secrets)"] } });
    expect(await run({ tool: "read", path: "cat" })).toBeNull();
    expect(await run("ls secrets")).toMatch(/read_file\(secrets\)/);
    expect(await run("ls src")).toBeNull();
  });

  it("strict: a tool op stops unless a read_file (or write_file) allow covers its path", async () => {
    const { run } = checker({
      toolPermission: "strict",
      permissions: { allow: ["read_file(src)", "write_file(docs)"] },
    });
    expect(await run({ tool: "read", path: "src/a.ts" })).toBeNull();
    expect(await run({ tool: "read", path: "docs/a.md" })).toBeNull();
    expect(await run({ tool: "read", path: "other.txt" })).toMatch(/strict/);
  });

  it("allowNonWorkspaceAccess:false stops a tool op whose path resolves outside the workspace", async () => {
    const { run } = checker({ allowNonWorkspaceAccess: false });
    expect(await run({ tool: "read", path: "/etc/hosts" })).toMatch(/workspace/);
    expect(await run({ tool: "read", path: "../elsewhere.txt" })).toMatch(/workspace/);
    expect(await run({ tool: "read", path: "inside.txt" })).toBeNull();
  });

  it("allowNonWorkspaceAccess absent or true does not add a workspace stop", async () => {
    expect(await checker({}).run({ tool: "read", path: "/etc/hosts" })).toBeNull();
    expect(await checker({ allowNonWorkspaceAccess: true }).run({ tool: "read", path: "/etc/hosts" })).toBeNull();
  });
});

describe("antigravity policy — fail closed", () => {
  it("unparseable JSON stops every operation", async () => {
    const { run } = checker("{ not json");
    expect(await run("ls")).toMatch(/settings\.json/);
    expect(await run({ tool: "read", path: "a" })).toMatch(/settings\.json/);
  });

  it("a structurally wrong permissions block fails closed", async () => {
    expect(await checker({ permissions: { deny: "command(git)" } }).run("ls")).not.toBeNull();
    expect(await checker({ permissions: [] }).run("ls")).not.toBeNull();
    expect(await checker({ toolPermission: 3 }).run("ls")).not.toBeNull();
    expect(await checker({ allowNonWorkspaceAccess: "no" }).run("ls")).not.toBeNull();
    expect(await checker([1, 2]).run("ls")).not.toBeNull();
  });

  it("an unknown grant syntax in deny/ask fails closed", async () => {
    expect(await checker({ permissions: { deny: ["git push"] } }).run("ls")).not.toBeNull();
    expect(await checker({ permissions: { ask: ["delete_everything(x)"] } }).run({ tool: "read", path: "a" })).not.toBeNull();
    expect(await checker({ permissions: { deny: ["read_file(regex:.*)"] } }).run({ tool: "read", path: "a" })).not.toBeNull();
  });

  it("an unknown grant syntax in allow is ignored", async () => {
    const { run } = checker({ permissions: { allow: ["garbage", "whatever(x)"] } });
    expect(await run("ls")).toBeNull();
  });

  it("grants for actions predexec never performs (mcp, read_url, write_file deny) are ignored, not failed closed", async () => {
    const { run } = checker({
      permissions: { deny: ["mcp(*)", "read_url(*)", "execute_url(*)", "write_file(*)"], ask: ["unsandboxed(ls)"] },
    });
    expect(await run("ls")).toBeNull();
    expect(await run({ tool: "read", path: "a" })).toBeNull();
  });
});

describe("antigravity policy — through the engine", () => {
  it("a deny match is a policyStop before the command runs", async () => {
    const { home, ws } = setup({ permissions: { deny: ["command(cat)"] } });
    writeFileSync(join(ws, "marker.txt"), "SECRET");
    const result = await runPlanTree(
      { root: "a", nodes: [{ id: "a", commands: ["cat marker.txt"] }] },
      { cwd: ws, checkOperationPolicy: createAntigravityPolicyChecker({ home, cwd: ws, env: {} }) },
    );
    expect(result.stoppedReason).toBe("policyStop");
    expect(result.transcript).not.toContain("SECRET");
  });
});

describe("resolveAntigravityRoot", () => {
  function tree() {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "px-agy-root-")));
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "sub", "deeper"), { recursive: true });
    return { repo };
  }

  it("--root wins, resolved against cwd", () => {
    const { repo } = tree();
    expect(resolveAntigravityRoot({ cwd: join(repo, "sub"), root: "..", env: { PREDEXEC_ROOT: "/nope" } })).toEqual({ root: repo });
  });

  it("PREDEXEC_ROOT is used when no --root is given", () => {
    const { repo } = tree();
    expect(resolveAntigravityRoot({ cwd: tmp, env: { PREDEXEC_ROOT: repo } })).toEqual({ root: repo });
  });

  it("an explicit root that is not a directory is an error, not a fallback", () => {
    const { repo } = tree();
    const r = resolveAntigravityRoot({ cwd: repo, root: join(repo, "missing") });
    expect("error" in r && r.error).toMatch(/missing/);
  });

  it("walks up from a subdir to the nearest .git or .agents ancestor", () => {
    const { repo } = tree();
    expect(resolveAntigravityRoot({ cwd: join(repo, "sub", "deeper"), env: {} })).toEqual({ root: repo });
    mkdirSync(join(repo, "sub", ".agents"));
    expect(resolveAntigravityRoot({ cwd: join(repo, "sub", "deeper"), env: {} })).toEqual({ root: join(repo, "sub") });
  });

  /** A temp HOME with a marker in it, so the $HOME bound (R49) is exercised hermetically. */
  function homeTree() {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "px-agy-home-root-")));
    const home = join(tmp, "home");
    mkdirSync(join(home, ".agents"), { recursive: true });
    mkdirSync(join(home, "scratch", "deeper"), { recursive: true });
    return { home };
  }

  it("falls back to cwd when no marker exists below $HOME — ~/.agents never widens the root to ~", () => {
    const { home } = homeTree();
    const cwd = join(home, "scratch", "deeper");
    expect(resolveAntigravityRoot({ cwd, env: { HOME: home } })).toEqual({ root: cwd });
  });

  it("never selects an ancestor of $HOME either (a .git above HOME)", () => {
    const { home } = homeTree();
    mkdirSync(join(tmp, ".git"));
    const cwd = join(home, "scratch");
    expect(resolveAntigravityRoot({ cwd, env: { HOME: home } })).toEqual({ root: cwd });
  });

  it("a repo under $HOME still resolves to the repo root", () => {
    const { home } = homeTree();
    mkdirSync(join(home, "scratch", ".git"));
    expect(resolveAntigravityRoot({ cwd: join(home, "scratch", "deeper"), env: { HOME: home } })).toEqual({
      root: join(home, "scratch"),
    });
  });

  it("cwd == $HOME yields $HOME only through the cwd fallback", () => {
    const { home } = homeTree();
    expect(resolveAntigravityRoot({ cwd: home, env: { HOME: home } })).toEqual({ root: home });
  });

  it("an explicit root is honored as given, even $HOME", () => {
    const { home } = homeTree();
    expect(resolveAntigravityRoot({ cwd: join(home, "scratch"), root: home, env: { HOME: home } })).toEqual({ root: home });
  });

  it("refuses as a plugin server when cwd is INSIDE PLUGIN_ROOT, not only equal to it", () => {
    const { repo } = tree();
    const plugin = join(repo, ".agents", "plugins", "predexec");
    mkdirSync(join(plugin, "sub"), { recursive: true });
    const r = resolveAntigravityRoot({ cwd: join(plugin, "sub"), env: { PLUGIN_ROOT: plugin } });
    expect("error" in r).toBe(true);
  });

  it("as a plugin server (cwd == PLUGIN_ROOT) with no explicit root, it is an error naming --root/PREDEXEC_ROOT", () => {
    const { repo } = tree();
    const plugin = join(repo, ".agents", "plugins", "predexec");
    mkdirSync(plugin, { recursive: true });
    const r = resolveAntigravityRoot({ cwd: plugin, env: { PLUGIN_ROOT: plugin } });
    expect("error" in r).toBe(true);
    expect((r as { error: string }).error).toMatch(/--root/);
    expect((r as { error: string }).error).toMatch(/PREDEXEC_ROOT/);
    // ...an explicit root fixes it
    expect(resolveAntigravityRoot({ cwd: plugin, env: { PLUGIN_ROOT: plugin, PREDEXEC_ROOT: repo } })).toEqual({ root: repo });
  });
});

describe("data-fed operands (E-B): stop when a grant could match the command that receives them", () => {
  const DATA_FED = [
    "echo .env | xargs cat",
    "while read f; do cat \"$f\"; done < list",
    "cat $(cat names.txt)",
  ];

  it.each(DATA_FED)("command(cat .env) deny stops %s", (command) => {
    const { run } = checker({ permissions: { deny: ["command(cat .env)"] } });
    expect(run(command)).toMatch(/operands of 'cat'.*can't be checked/);
  });

  it.each(DATA_FED)("read_file(.env) deny stops %s", (command) => {
    const { run } = checker({ permissions: { deny: ["read_file(.env)"] } });
    expect(run(command)).toMatch(/can't be checked/);
  });

  it("ask, regex and wildcard grants count; allow and unrelated grants do not", () => {
    expect(checker({ permissions: { ask: ["command(cat .env)"] } }).run("echo .env | xargs cat")).toBeTruthy();
    expect(checker({ permissions: { deny: ["command(regex:ca.* \\.env)"] } }).run("echo .env | xargs cat")).toBeTruthy();
    expect(checker({ permissions: { deny: ["command(*)"] } }).run("echo .env | xargs cat")).toBeTruthy();
    expect(checker({ permissions: { allow: ["command(cat .env)"] } }).run("echo .env | xargs cat")).toBeNull();
    expect(checker({ permissions: { deny: ["command(git push)"] } }).run("echo .env | xargs cat")).toBeNull();
  });

  it("with no grant naming cat and no read_file grants, the xargs read runs normally", async () => {
    const { ws, home } = setup({ permissions: { deny: ["command(git push)"] } });
    writeFileSync(join(ws, "note.txt"), "PLAIN\n");
    const check = createAntigravityPolicyChecker({ home, cwd: ws, env: {} });
    const r = await runPlanTree(
      { root: "a", nodes: [{ id: "a", commands: ["echo note.txt | xargs cat"] }] },
      { cwd: ws, checkOperationPolicy: check },
    );
    expect(r.stoppedReason).not.toBe("policyStop");
    expect(r.transcript).toContain("PLAIN");
  });
});

describe("fix round 1: xargs shell payloads, find -exec, parallel and regex grants (Antigravity)", () => {
  const LAUNCHED = [
    "cat list | xargs -I{} sh -c 'cat {}'",
    "find . -name '.e*' -exec cat {} +",
    "find . -name '.e*' -execdir cat {} \;",
    "cat list | parallel cat",
    "parallel cat :::: list",
  ];
  it.each(LAUNCHED)("command(cat .env) deny stops %s", (command) => {
    expect(checker({ permissions: { deny: ["command(cat .env)"] } }).run(command)).toMatch(/operands of 'cat'.*can't be checked/);
  });
  it.each(LAUNCHED)("read_file(.env) deny stops %s", (command) => {
    expect(checker({ permissions: { deny: ["read_file(.env)"] } }).run(command)).toMatch(/can't be checked/);
  });

  it.each<[string, string]>([
    ["command(regex:/usr/bin/cat \\.env)", "echo .env | xargs /usr/bin/cat"],
    ["command(regex:timeout 5 cat \\.env)", "echo .env | xargs timeout 5 cat"],
    ["command(regex:^(cat|head)$ \\.env)", "echo .env | xargs cat"],
    ["command(regex:.*cat \\.env)", "echo .env | xargs cat"],
  ])("regex grant %s stops %s", (grant, command) => {
    expect(checker({ permissions: { deny: [grant] } }).run(command)).toMatch(/can't be checked/);
  });

  it("a literal regex grant naming another command does not stop", () => {
    expect(checker({ permissions: { deny: ["command(regex:git push)"] } }).run("echo .env | xargs cat")).toBeNull();
  });
});

describe("path operands of any head (E-E, Antigravity read_file grants)", () => {
  const stops = [
    "cat .env",
    "column .env",
    "fold .env",
    "expand .env",
    "strings .env",
    "unknowntool .env",
    "git diff --no-index .env x",
    "unknowntool --file=.env",
    "cat < .env",
    "cat .en?",
    "cat .e*",
    "cat [.]env",
    "head ./.en[v]",
    "grep -r KEY .",
    "unknowntool $F",
  ];
  it.each(stops)("read_file(.env) deny stops `%s`", (command) => {
    const { ws, run } = checker({ permissions: { deny: ["read_file(.env)"] } });
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, ".env"), "TOKEN=1\n");
    expect(run(command)).toMatch(/deny: read_file\(\.env\)/);
  });
  it.each(stops)("read_file(.env) ask stops `%s`", (command) => {
    const { ws, run } = checker({ permissions: { ask: ["read_file(.env)"] } });
    writeFileSync(join(ws, ".env"), "TOKEN=1\n");
    expect(run(command)).toMatch(/ask: read_file\(\.env\)/);
  });

  it.each(["echo hello", "ls src", "git status", "grep -r KEY src", "cat src/a.ts"])("read_file(.env) deny allows `%s`", (command) => {
    const { ws, run } = checker({ permissions: { deny: ["read_file(.env)"] } });
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "src", "a.ts"), "a\n");
    writeFileSync(join(ws, ".env"), "TOKEN=1\n");
    expect(run(command)).toBeNull();
  });

  it("no read_file grants: shell operands are not inspected", () => {
    const { run } = checker({ permissions: { deny: ["command(git push)"] } });
    expect(run("cat $F")).toBeNull();
  });

  it("an unevaluable read_file deny fails closed for shell path operands too", () => {
    const { run } = checker({ permissions: { deny: ["read_file(regex:.*)"] } });
    expect(run("cat README.md")).toMatch(/read_file target predexec cannot evaluate/);
  });
});

describe("R24: non-reading builtins and git object paths (Antigravity)", () => {
  const prep = () => {
    const c = checker({ permissions: { deny: ["read_file(.env)"] } });
    mkdirSync(join(c.ws, "src"));
    writeFileSync(join(c.ws, ".env"), "TOKEN=1\n");
    writeFileSync(join(c.ws, "README.md"), "hello\n");
    return c.run;
  };
  it.each(["echo .env", 'echo "$HOME"', "printenv HOME", "test -f .env", "git show HEAD:README.md"])("allows `%s`", (command) => {
    expect(prep()(command)).toBeNull();
  });
  it.each([
    "git show HEAD:.env",
    "git show :.env",
    "git cat-file -p HEAD:.env",
    "git cat-file blob HEAD:.env",
    "git log -p -- .env",
    "git diff HEAD~1 -- .env",
    "cd src && git show HEAD:.env",
  ])("read_file(.env) deny stops `%s`", (command) => {
    expect(prep()(command)).toMatch(/deny: read_file\(\.env\)/);
  });
});

describe("Task 7 fix round 1 (Antigravity)", () => {
  const prep = () => {
    const c = checker({ permissions: { deny: ["read_file(.env)"] } });
    mkdirSync(join(c.ws, "src"));
    writeFileSync(join(c.ws, "src", "a.ts"), "a\n");
    writeFileSync(join(c.ws, ".env"), "TOKEN=1\n");
    writeFileSync(join(c.ws, "README.md"), "hello\n");
    return c.run;
  };
  it.each([
    "cat<.env", "cat -n<.env", "head<.env", "column<.env", "x=1 cat<.env", "echo hi;cat<.env", "cat 2>/dev/null<.env",
    "cat .[[:alpha:]]nv", "cat .[[:alpha:]]n?", "cat .e[[:alpha:]]v",
    "base64 -i.env", "unknowntool -i.env", "diff --from-file=.env README.md", "diff --to-file=.env README.md",
    // I1: recursive searches with no path search the cwd
    "grep -r KEY", "grep -rn KEY", "grep -R KEY", "grep --recursive KEY", "rg KEY", "rg --hidden KEY", "rg -uu KEY",
    "rg -e KEY", "ag KEY", "ack KEY",
    `python3 -c "print(open('.env').read())"`,
    `node -e "console.log(require('fs').readFileSync('.env','utf8'))"`,
  ])("read_file(.env) deny stops `%s`", (command) => {
    expect(prep()(command)).toMatch(/deny: read_file\(\.env\)/);
  });
  it.each([
    "grep KEY README.md", "rg KEY src", "grep -r KEY src", "cut -d. -f1 README.md",
    `python3 -c "print(open('README.md').read())"`,
  ])("read_file(.env) deny allows `%s`", (command) => {
    expect(prep()(command)).toBeNull();
  });
});

describe("Task 7 fix round 2 (Antigravity)", () => {
  const prep = () => {
    const c = checker({ permissions: { deny: ["read_file(.env)"] } });
    writeFileSync(join(c.ws, ".env"), "TOKEN=1\n");
    writeFileSync(join(c.ws, "README.md"), "hello\n");
    return c.run;
  };
  it.each([
    'x=`echo "hi"` cat<.env',
    'x=$(echo "(") cat<.env',
    'x="$(echo "(")" cat<.env',
    "x=${y:-(} cat<.env",
    'cat <<<"$(echo "(")"<.env',
    `perl -e 'local @ARGV=(".env"); print <>'`,
    `perl -e '@ARGV=(".env"); print <<>>'`,
    `perl -e 'local @ARGV=(".e"."nv"); print <>'`,
  ])("read_file(.env) deny stops `%s`", (command) => {
    expect(prep()(command)).toMatch(/deny: read_file\(\.env\)/);
  });
  // R31: a literal @ARGV list is no longer trusted, even a harmless one.
  it("stops `perl -e '@ARGV=(\"README.md\"); print <>'`", () => {
    expect(prep()(`perl -e '@ARGV=("README.md"); print <>'`)).toMatch(/deny: read_file\(\.env\)/);
  });

  it.each(["wc -l < README.md"])("allows `%s`", (command) => {
    expect(prep()(command)).toBeNull();
  });
});

describe("Task 7 fix round 3 (Antigravity)", () => {
  const prep = () => {
    const c = checker({ permissions: { deny: ["read_file(.env)"] } });
    writeFileSync(join(c.ws, ".env"), "TOKEN=1\n");
    writeFileSync(join(c.ws, "README.md"), "hello\n");
    return c.run;
  };
  it.each([
    `perl -e 'for (@ARGV) { $_ = ".env" } print <>' README.md`,
    `perl -e '@{"AR"."GV"}=(".env"); print <>'`,
    `perl -e '*{"AR"."GV"}=[".env"]; print <>'`,
    `perl -e '@main::ARGV=(".env"); print <>'`,
  ])("read_file(.env) deny stops `%s`", (command) => {
    expect(prep()(command)).toMatch(/deny: read_file\(\.env\)/);
  });
  it("stops `perl -e 'local @ARGV=(\"README.md\"); print <>'` (R31)", () => {
    expect(prep()(`perl -e 'local @ARGV=("README.md"); print <>'`)).toMatch(/deny: read_file\(\.env\)/);
  });

  it.each(["perl -ne 'print if /x/' README.md"])("allows `%s`", (command) => {
    expect(prep()(command)).toBeNull();
  });
});

describe("Task 7 fix round 4: perl magic-open channel (R31, Antigravity)", () => {
  const prep = () => {
    const c = checker({ permissions: { deny: ["read_file(.env)"] } });
    writeFileSync(join(c.ws, ".env"), "TOKEN=1\n");
    writeFileSync(join(c.ws, "README.md"), "hello\n");
    return c.run;
  };
  it.each([
    `perl -e '@ARGV = ("<.env"); print <>'`,
    `perl -e '@ARGV = (" .env"); print <>'`,
    `perl -e '@ARGV = (".env "); print <>'`,
    `perl -e '@ARGV = ("+<.env"); print <>'`,
    `perl -e '@ARGV = qw(<.env); print <>'`,
    `perl -e '@ARGV=("x|"); print <>'`,
    `perl -e '*F = $::{"AR"."GV"}; @F = (".env"); print <>'`,
    `perl -e '*F = $main::{"AR"."GV"}; @F = (".env"); print <>'`,
    `perl -e '(*F) = $::{"AR"."GV"}; @F = (".env"); print <>'`,
    `perl -e '*F = "AR"."GV"; @F = (".env"); print <>'`,
    `perl -ne print 'x|'`,
    `perl -pe 1 '<.env'`,
    `perl -ne 1 ' .env'`,
    `perl -e 'print <>' '+<.env'`,
  ])("read_file(.env) deny stops `%s`", (command) => {
    expect(prep()(command)).toMatch(/deny: read_file\(\.env\)/);
  });
  it.each([`perl -ne 'print if /x/' README.md`, `perl -e 'print <<>>' README.md`, `perl -ne 'print' -`])("allows `%s`", (command) => {
    expect(prep()(command)).toBeNull();
  });
});
