import { describe, expect, it } from "vitest";
import { findDestructiveToken, isDestructiveCommand } from "../../core/destructive.ts";

/**
 * D1: an interpreter or task runner running a repository file runs
 * repo-controlled code, so it is mutating unless the USER allowlists that
 * exact command prefix or script path. Nothing here is ever executed.
 */
describe("D1 — interpreters and task runners running repo files are mutating", () => {
  it.each([
    "python3 script.py",
    "python3 -m mypkg",
    "python3 < x.py",
    "node x.js",
    "node --run build",
    "node --test",
    "ruby x.rb",
    "perl x.pl",
    "deno run x.ts",
    "deno task x",
    "deno serve x.ts",
    "deno x.ts",
    "bun x.ts",
    "bun run build",
    "npx eslint .",
    "pnpm dlx x",
    "bunx x",
    "make",
    "make test",
    // Dry runs still expand $(shell …) while parsing and run `+` recipes (R34).
    "make -n",
    "make -n test",
    "make --dry-run",
    "make --just-print",
    "make --recon",
    "make -kn",
    "make -q",
    "gmake -n",
    "just",
    "just build",
    "npm run lint",
    "npm test",
    "pnpm run lint",
    "pnpm lint",
    "yarn lint",
    "yarn",
    "cargo run",
    "cargo test",
    "cargo xtask",
    "go run .",
    "go test ./...",
    "go generate ./...",
    "Rscript f.R",
    "php x.php",
    "./build.sh",
    "scripts/run",
    "./node_modules/.bin/vitest run",
    "./cat README.md",
    "pytest",
    "uv run x.py",
    "poetry run pytest",
    "bundle exec rake",
    "python3 -m json.tool in.json out.json",
    "env X=1 python3 scripts/report.py",
    "timeout 5 node x.js",
    "cd sub && node x.js",
    "echo $(node x.js)",
    "find . -name '*.js' -exec node {} \\;",
    "npm --prefix sub run lint",
    // R38 I3: an executable by absolute path outside the system prefixes may
    // be a repository file (the classifier does not know the session root).
    "/Users/u/repo/build.sh",
    "/tmp/x/run",
    "~/bin/tool",
    "/usr/../Users/u/repo/build.sh",
    "/usr/bin/../../Users/u/x",
    "$PWD/build.sh",
    // R38 I4: readers that execute repository-configured code.
    "yarn why react",
    "yarn info",
    "yarn --version",
    "composer show",
    "composer --version",
    "cargo tree",
    "cargo metadata --format-version 1",
    "mvn -v",
    "mvn --version",
    "pytest --version",
    "gradle --version",
    // R38 I5: deno fmt/lint write files or run lint plugins.
    "deno fmt",
    "deno fmt --check",
    "deno lint",
    "deno lint --fix",
  ])("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));

  it.each([
    "python3 -c 'print(1)'",
    "python3 -m json.tool f.json",
    "python3 -m json.tool --sort-keys f.json",
    "python3 --version",
    "node --version",
    "node -e 'console.log(1)'",
    "make --version",
    "make -v",
    "make --help",
    "just --list",
    "npm ls",
    "npm view react version",
    "pnpm ls --depth 0",
    "go version",
    "go env GOPATH",
    "go list ./...",
    "deno --version",
    "Rscript --version",
    "/usr/bin/grep x f",
    "/bin/ls",
    "/sbin/md5 f",
    "/opt/homebrew/bin/rg x",
    "/usr/local/bin/jq . f",
    "/nix/store/abc-ripgrep/bin/rg x",
    "cargo --version",
  ])("read-only: %s", (c) => expect(findDestructiveToken(c)).toBeNull());

  it("names the script and how to allow it", () => {
    expect(findDestructiveToken("python3 script.py")).toBe(
      "runs repository script python3 script.py (allow via PREDEXEC_ALLOW_SCRIPTS or ~/.config/predexec/config.json)",
    );
    expect(findDestructiveToken("env X=1 npm run lint")).toMatch(/^runs repository script npm run lint /);
  });
});

describe("R38 I4: tool-config environment variables are command-bearing", () => {
  it.each([
    "RUSTC=./x cargo --version",
    "RUSTC_WRAPPER=./x cargo --version",
    "CARGO_BUILD_RUSTC=./x ls",
    "CARGO_BUILD_RUSTC_WRAPPER=./x ls",
    "GOFLAGS=-toolexec=./x go version",
    "npm_config_script_shell=./evil npm ls",
    "NPM_CONFIG_SCRIPT_SHELL=./evil npm ls",
    "npm_config_node_options=--require=./evil npm ls",
    "MAKEFLAGS=--eval=x make --version",
    "MFLAGS=x ls",
    "env GOFLAGS=-toolexec=./x go version",
    "env RUSTC_WRAPPER=./x ls",
    "export RUSTC_WRAPPER=./x",
    "export MAKEFLAGS=x; make --version",
    "export npm_config_script_shell=./evil",
    "declare -x GOFLAGS=x",
  ])("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));

  it.each([
    "npm_config_script_shell=./evil npm run lint",
    "MAKEFLAGS=--eval=x make test",
    "GOFLAGS=-toolexec=./evil go test ./...",
    "RUSTC_WRAPPER=./evil cargo test",
  ])("an allowlisted run with a command-bearing prefix stays mutating: %s", (c) =>
    expect(isDestructiveCommand(c, { allowScripts: ["npm run lint", "make test", "go test", "cargo test"] })).toBe(true));
});

describe("D1 user allowlist (ClassifierOptions.allowScripts)", () => {
  const options = { allowScripts: ["python3 scripts/report.py", "npm run lint"] };

  it.each([
    "python3 scripts/report.py",
    "python3 scripts/report.py --since 2026",
    "env X=1 python3 scripts/report.py",
    "npm run lint",
    "npm run lint -- --quiet",
    "cd sub && npm run lint",
  ])("allowlisted prefix is read-only: %s", (c) => expect(findDestructiveToken(c, options)).toBeNull());

  it.each([
    "python3 scripts/other.py",
    "python3 scripts/report.pyc",
    "npm run lint:fix",
    "npm run build",
    "node x.js",
    "python3 scripts/report.py; rm x",
    "python3 scripts/report.py > out.txt",
    "npm run lint && make",
    "PYTHONSTARTUP=evil.py python3 scripts/report.py",
  ])("everything else stays mutating: %s", (c) => expect(isDestructiveCommand(c, options)).toBe(true));

  it("a bare script-path entry allows that script under any interpreter spelling", () => {
    const byPath = { allowScripts: ["scripts/report.py"] };
    expect(findDestructiveToken("python3 scripts/report.py", byPath)).toBeNull();
    expect(findDestructiveToken("python3 -u scripts/report.py", byPath)).toBeNull();
    expect(isDestructiveCommand("python3 scripts/other.py", byPath)).toBe(true);
    expect(findDestructiveToken("./build.sh", { allowScripts: ["./build.sh"] })).toBeNull();
  });

  it("a one-word path entry never matches a python -m module (R38 minor 2)", () => {
    expect(isDestructiveCommand("python3 -m json", { allowScripts: ["json"] })).toBe(true);
    expect(isDestructiveCommand("python3 -m x.py", { allowScripts: ["x.py"] })).toBe(true);
    expect(findDestructiveToken("python3 -m mypkg", { allowScripts: ["python3 -m mypkg"] })).toBeNull();
  });

  it("an absolute-path repo executable is allowlistable by its exact path", () => {
    expect(findDestructiveToken("/Users/u/repo/build.sh", { allowScripts: ["/Users/u/repo/build.sh"] })).toBeNull();
  });

  it("does not leak into a later call without options", () => {
    expect(findDestructiveToken("npm run lint", options)).toBeNull();
    expect(isDestructiveCommand("npm run lint")).toBe(true);
  });
});

describe("engine threads RunOptions.classifier to the mutation gate", () => {
  it("stops a repo script by default and runs it when the user allowlists it", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runPlanTree } = await import("../../core/engine.ts");
    const dir = mkdtempSync(join(tmpdir(), "px-d1-engine-"));
    try {
      writeFileSync(join(dir, "hello.sh"), "#!/bin/sh\necho hello-from-allowlisted-script\n", { mode: 0o755 });
      const plan = { root: "a", nodes: [{ id: "a", commands: ["./hello.sh"] }] };
      const stopped = await runPlanTree(plan, { cwd: dir });
      expect(stopped.stoppedReason).toBe("mutationStop");
      expect(stopped.transcript).toContain("runs repository script ./hello.sh");
      const ran = await runPlanTree(plan, { cwd: dir, classifier: { allowScripts: ["./hello.sh"] } });
      expect(ran.stoppedReason).not.toBe("mutationStop");
      expect(ran.transcript).toContain("hello-from-allowlisted-script");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
