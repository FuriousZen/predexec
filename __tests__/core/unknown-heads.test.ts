import { describe, expect, it } from "vitest";
import { findDestructiveToken, isDestructiveCommand } from "../../core/destructive.ts";

/**
 * S — allowlist inversion: a command head the classifier does not know is
 * MUTATING ("unknown command <head>"). Known = the curated READ_ONLY_HEADS,
 * shell builtins, git/D1-governed tools, READ_ONLY_SUBCOMMANDS, or the USER's
 * ClassifierOptions.extraReadOnlyHeads. Nothing here is ever executed.
 */

/** Realistic read-only exploration: every one must stay read-only. */
const EXPLORATION: string[] = [
  // coreutils readers
  "cat README.md", "cat -n src/index.ts", "head -n 50 src/app.ts", "tail -n 100 log.txt", "tail -f /dev/null",
  "ls", "ls -la", "ls -R src", "wc -l src/*.ts", "sort names.txt", "sort -u -k2 data.csv", "uniq -c counts.txt",
  "cut -d, -f1 data.csv", "tr a-z A-Z < f.txt", "column -t data.tsv", "comm -12 a b", "paste a b", "nl f", "tac f",
  "od -c f", "xxd f | head", "hexdump -C f | head", "strings bin/app | head", "fold -w 80 f", "rev f",
  "diff a.txt b.txt", "diff -u a b", "cmp a b", "md5sum f", "sha1sum f", "sha256sum f", "sha512sum f", "shasum -a 256 f",
  "realpath .", "dirname /a/b/c", "basename /a/b/c.ts .ts", "readlink -f link", "stat f", "stat -c %s f", "file bin/app",
  "du -sh .", "du -h -d 1", "df -h", "tree -L 2", "tree -a src", "find . -name '*.ts'", "find src -type f -newer x",
  "less README.md", "more f", "seq 1 10", "expr 1 + 2", "yes | head -n 3",
  // search & structured data
  "grep -rn TODO src", "grep -c foo f", "egrep 'a|b' f", "rg TODO", "rg -n 'fn main' --type rust", "fd '\\.ts$'", "fd -e md",
  "jq '.name' package.json", "jq -r '.dependencies | keys[]' package.json", "yq '.services' docker-compose.yml",
  "awk '{print $1}' f", "sed -n '1,20p' f",
  // git read verbs
  "git status", "git status --short", "git log --oneline -10", "git diff", "git diff --stat HEAD~1", "git show HEAD",
  "git branch -v", "git branch --list", "git remote -v", "git blame src/a.ts", "git rev-parse HEAD", "git ls-files",
  "git tag -l", "git stash list", "git config --get user.name", "git shortlog -sn", "git describe --tags",
  "git grep foo",
  // package managers
  "npm ls", "npm ls --depth=0", "npm view react version", "npm outdated", "npm why lodash", "npm --version", "npm config get registry",
  "pnpm ls", "pnpm list --depth 0", "pnpm outdated", "pnpm why zod", "pnpm --version", "pnpm view zod",
  "cargo --version", "cargo version", "cargo search serde",
  "go version", "go env", "go env GOPATH", "go list ./...", "go list -m all", "go doc fmt.Println", "go mod graph",
  "pip list", "pip show requests", "pip freeze", "pip --version", "pip3 list", "pip3 show numpy",
  "brew list", "brew info node", "brew --version", "brew --prefix", "brew --prefix node", "brew deps node", "brew search jq",
  // clusters & containers
  "kubectl get pods", "kubectl get pods -n kube-system -o wide", "kubectl describe pod web-1", "kubectl logs web-1",
  "kubectl logs -f web-1 --tail=50", "kubectl version --client", "kubectl config current-context", "kubectl config get-contexts",
  "kubectl explain deployment", "kubectl api-resources", "kubectl top pods",
  "docker ps", "docker ps -a", "docker images", "docker inspect web", "docker logs web", "docker logs --tail 100 web",
  "docker version", "docker info", "docker image ls", "docker container ls", "docker network ls", "docker volume ls",
  "gh pr view 12", "gh pr list", "gh pr diff 12", "gh pr status", "gh pr checks 12", "gh issue view 3", "gh issue list",
  "gh repo view", "gh run list", "gh run view 123",
  // system info
  "uname -a", "whoami", "id", "date", "date -u +%s", "env", "printenv PATH", "which node", "type ls", "command -v node",
  "hostname", "uptime", "ps aux", "ps -ef | grep node", "lsof -i :3000", "pwd", "echo $HOME", "printf '%s\\n' a b",
  "nproc", "sw_vers", "locale", "groups", "pgrep -l node",
  // builtins, keywords, composition
  "cd src && ls", "test -f package.json && cat package.json", "[ -d node_modules ] && echo yes", "true", "false",
  "if [ -f a ]; then cat a; else echo none; fi", "for f in src/*.ts; do wc -l \"$f\"; done",
  "while read -r line; do echo \"$line\"; done < list.txt", "case \"$x\" in a) echo a;; b|c) echo b;; esac",
  "x=1; echo $x", "export FOO=bar; echo $FOO", "cat a | sort | uniq -c | sort -rn | head",
  "ls src | wc -l", "timeout 5 cat f", "nice -n 5 grep foo f", "find . -name '*.log' | xargs wc -l", "find . -type f | xargs grep -l foo",
  "env FOO=1 printenv FOO", "time ls",
];

describe("realistic exploration stays read-only", () => {
  it.each(EXPLORATION)("%s", (c) => expect(findDestructiveToken(c)).toBeNull());
});

describe("unknown heads are mutating", () => {
  it.each([
    ["foo", "unknown command foo"],
    ["somecli --list", "unknown command somecli"],
    ["terraform plan", "unknown command terraform"],
    ["aws s3 ls", "unknown command aws"],
    ["/opt/homebrew/bin/terraform plan", "unknown command terraform"],
    ["cat f | foo", "unknown command foo"],
    ["ls && foo", "unknown command foo"],
    ["timeout 5 foo", "unknown command foo"],
    ["env X=1 foo", "unknown command foo"],
    ["command foo", "unknown command foo"],
    ["nice -n 5 foo", "unknown command foo"],
    ["find . | xargs foo", "unknown command foo"],
    ["for f in a b; do foo \"$f\"; done", "unknown command foo"],
    ["while true; do foo; done", "unknown command foo"],
    ["if foo; then echo y; fi", "unknown command foo"],
    ["if true; then echo y; else foo; fi", "unknown command foo"],
    ["case $x in a) echo a;; b) foo;; esac", "unknown command foo"],
    ["x=$(foo)", "unknown command foo"],
    ["echo `foo`", "unknown command foo"],
    ["cat <(foo)", "unknown command foo"],
    ["(cd src && foo)", "unknown command foo"],
    ["{ ls; foo; }", "unknown command foo"],
    ["! foo", "unknown command foo"],
    ["[[ -f a ]] && foo", "unknown command foo"],
    ["foo < in.txt 2>/dev/null", "unknown command foo"],
    ["bash -c 'foo'", "shell unknown command foo"],
    ["find . -exec foo {} +", "unknown command foo"],
    ["watch foo", "watch unknown command foo"],
    ["echo \"$(foo)\"", "unknown command foo"],
    // Moved here from other suites, which recorded them read-only before Task 9:
    // a quoted `$` is a literal command name, not an expansion.
    ["\\$not-expanded", "unknown command $not-expanded"],
    ["/sbin/ifconfig", "unknown command ifconfig"],
  ])("%s -> %s", (c, token) => expect(findDestructiveToken(c)).toBe(token));

  it("a repository path head keeps the D1 stop (more specific, with its allow hint)", () => {
    expect(findDestructiveToken("./bin/tool")).toMatch(/^runs repository script \.\/bin\/tool /);
  });

  // A defined function is a head the classifier cannot vouch for.
  it("shell functions are unknown heads", () => {
    expect(isDestructiveCommand("f() { cat x; }; f")).toBe(true);
  });
});

describe("user extension: extraReadOnlyHeads", () => {
  const options = { extraReadOnlyHeads: ["terraform plan", "aws s3 ls", "mytool"] };
  it.each(["terraform plan", "terraform plan -out=/dev/null", "aws s3 ls", "aws s3 ls s3://bucket", "mytool --list",
    "env X=1 mytool", "timeout 5 terraform plan"])("%s is read-only when listed", (c) =>
    expect(findDestructiveToken(c, options)).toBeNull());

  it.each([
    // Exact argv prefix: other subcommands, reordered words and paths do not match.
    ["terraform apply", "unknown command terraform"],
    ["terraform -chdir=x plan", "unknown command terraform"],
    ["aws s3 rb s3://b", "unknown command aws"],
    ["/usr/local/bin/mytool", "unknown command mytool"],
  ])("%s stays mutating", (c, token) => expect(findDestructiveToken(c, options)).toBe(token));

  // It lifts ONLY the unknown-command stop; every other rule still applies.
  it.each([
    ["mytool > out.txt", { extraReadOnlyHeads: ["mytool"] }],
    ["mytool && rm -rf x", { extraReadOnlyHeads: ["mytool"] }],
    ["rm -rf x", { extraReadOnlyHeads: ["rm"] }],
    ["./bin/tool", { extraReadOnlyHeads: ["./bin/tool"] }],
    ["npm run lint", { extraReadOnlyHeads: ["npm"] }],
    ["sudo ls", { extraReadOnlyHeads: ["sudo"] }],
    ["git push", { extraReadOnlyHeads: ["git"] }],
    ["python3 x.py", { extraReadOnlyHeads: ["python3"] }],
    ["mytool $(foo)", { extraReadOnlyHeads: ["mytool"] }],
    ["LD_PRELOAD=x.so mytool", { extraReadOnlyHeads: ["mytool"] }],
    ["eval mytool", { extraReadOnlyHeads: ["eval"] }],
  ])("%s stays mutating", (c, options) => expect(isDestructiveCommand(c, options)).toBe(true));

  it("allowScripts lets an allowlisted run through the inversion too", () => {
    expect(findDestructiveToken("uv run pytest", { allowScripts: ["uv run pytest"] })).toBeNull();
    expect(findDestructiveToken("./bin/tool", { allowScripts: ["./bin/tool"] })).toBeNull();
  });
});

describe("multi-tool subcommand lists: only read verbs", () => {
  it.each([
    "git push", "git commit -m x", "npm install", "npm i lodash", "pnpm add zod", "cargo build", "go build ./...",
    "kubectl apply -f x.yaml", "kubectl delete pod web", "kubectl exec web -- ls", "kubectl edit deploy web",
    "kubectl --kubeconfig ./k get pods", "kubectl get pods --kubeconfig=./k", "KUBECONFIG=./k kubectl get pods",
    "kubectl foo", "kubectl config use-context prod", "kubectl cluster-info dump --output-directory=x",
    "docker run alpine", "docker exec web ls", "docker rm web", "docker build .", "docker compose up",
    "docker --config ./d ps", "docker -H ssh://x ps", "DOCKER_HOST=ssh://x docker ps", "docker image rm x",
    "gh pr merge 12", "gh pr checkout 12", "gh pr create", "gh issue create", "gh api repos/x/y", "gh pr view 12 --web",
    "gh repo clone x/y", "gh extension install x", "gh foo",
    "pip install requests", "pip uninstall x", "pip3 download x", "pip --python ./venv/bin/python list",
    "brew install jq", "brew upgrade", "brew tap x/y", "brew outdated",
  ])("%s is mutating", (c) => expect(isDestructiveCommand(c)).toBe(true));
});

/** Ruling R37 (from Task 8) and Task 5: each is mutating and on no read-only list. */
describe("R37 mandatory mutating rows", () => {
  it.each([
    "strace ./x", "strace python3 x.py", "strace ls", "ltrace ls", "valgrind ls", "perf stat ls", "perf record ls",
    "hyperfine ls", "unbuffer ls", "caffeinate ls", "setsid ls", "taskset 1 ls", "ionice ls", "chronic ls",
    "lldb -b -o run ./x", "lldb ls", "dtruss ls", "sandbox-exec -n x ls", "arch -arm64 ls", "arch", "xcrun python3 x.py",
    "xcrun ls", "direnv exec . ls", "mise exec -- ls", "nix-shell --run ls", "pyenv exec python x.py",
    "conda run python x.py", "pipx run x", "pipx run --spec . x", "lua x.lua", "julia x.jl", "java X.java",
    "elixir x.exs", "groovy x", "kotlin x.kts", "scala x", "runghc x.hs", "dotnet run", "swift run", "cabal run",
    "stack run", "mix test", "bazel run x", "dart run", "flutter test", "ninja", "cmake --build .", "meson test",
    "emacsclient f", "emacsclient -e '(kill-emacs)'", "gview f", "evim f", "rview f", "rvim f",
  ])("%s is mutating", (c) => expect(isDestructiveCommand(c)).toBe(true));
});

describe("shell builtins and keywords are handled explicitly", () => {
  it.each([
    "echo hi", "printf x", "test -d src", "[ -f a ]", "[[ -n $x ]]", "true", "false", ":", "cd src", "cd", "pwd",
    "read -r x < f", "export FOO=bar", "export FOO", "declare -r X=1", "local x=1", "readonly X=1", "unset X",
    "set -e", "set -euo pipefail", "shift", "exit 0", "return 1", "wait", "sleep 1", "x=1", "x=1 y=2",
    "for f in a b; do echo $f; done", "for f; do echo $f; done", "for ((i=0;i<3;i++)); do echo $i; done",
    "select x in a b; do echo $x; done", "until false; do break; done", "while :; do break; done",
    "if [ -f a ]; then cat a; elif [ -f b ]; then cat b; fi", "case $x in a|b) echo a;; c) echo c;; esac",
    "(( x = 1 + 2 )); echo $x", "{ echo a; echo b; }", "(cd src; ls)", "time ls", "command -v terraform",
    "cat <<EOF\nhello world\nfoo bar\nEOF", "let x=1", "mapfile -t arr < f", "x=(a b c)", "ruby -eputs(\"ok\")",
  ])("%s is read-only", (c) => expect(findDestructiveToken(c)).toBeNull());

  it.each([
    ["alias ll='ls -l'", "unknown command alias"],
    ["trap 'foo' EXIT", "unknown command trap"],
  ])("%s -> %s", (c, token) => expect(findDestructiveToken(c)).toBe(token));
});

describe("the inversion stays linear", () => {
  it.each([
    `case x in a) echo ${"in ".repeat(15000)};; esac`,
    `echo ${"a(".repeat(15000)}`,
    `${"x=1; ".repeat(8000)}ls`,
  ])("%#", (command) => {
    const started = performance.now();
    findDestructiveToken(command, { extraReadOnlyHeads: Array.from({ length: 500 }, (_, i) => `tool${i} sub`) });
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

// bash reads `((` as arithmetic only when the paren matching the second `(`
// is followed at once by `)`; otherwise it is nested subshells that run.
describe("(( … )) that bash re-reads as subshells", () => {
  it.each(["((foo) )", "((foo); ls)", "((ls) ) && foo", "(( 'x' ))"])("%s is mutating", (c) =>
    expect(isDestructiveCommand(c)).toBe(true));
  it.each(["(( x = (1+2) ))", "((a)) && ((b)); ls", "if ((x == 1)); then ls; fi", "while ((i<3)); do :; done"])(
    "%s is read-only", (c) => expect(findDestructiveToken(c)).toBeNull());
  it.each(["{ls", "!ls"])("%s names the command `%s`, not ls", (c) => expect(isDestructiveCommand(c)).toBe(true));
});

describe("heredoc bodies", () => {
  // An unquoted heredoc runs its body's substitutions; masking hides them from
  // the first pass, so the second (unmasked) pass classifies them.
  it.each(["cat <<EOF\n$(foo)\nEOF", "cat <<EOF\nx `foo` y\nEOF"])("%s is mutating", (c) =>
    expect(findDestructiveToken(c)).toBe("unknown command foo"));
  it.each(["cat <<EOF\nhello world\nEOF", "cat <<'EOF'\nsome prose; more prose\nEOF", "python3 - <<'EOF'\nprint(1)\nEOF"])(
    "%s is read-only", (c) => expect(findDestructiveToken(c)).toBeNull());
});

// Inside backticks `\`` loses its backslash, so an escaped backtick pair in a
// backtick body is a nested command substitution (bash runs it).
describe("nested backtick substitutions", () => {
  it.each(["echo `echo \\`foo\\``", "echo `echo \\`echo \\\\\\`foo\\\\\\`\\``"])("%s is mutating", (c) =>
    expect(findDestructiveToken(c)).toBe("unknown command foo"));
  it.each(["echo `echo \\`ls\\``", "echo `echo \\\\\\`foo\\\\\\``"])("%s is read-only", (c) =>
    expect(findDestructiveToken(c)).toBeNull());
  it("stays bounded on deeply nested bodies", () => {
    let command = "echo \\`x\\`";
    for (let i = 0; i < 24; i++) command = "echo $(" + command + ") \\`y\\`";
    const started = performance.now();
    expect(isDestructiveCommand(command)).toBe(true);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

// R39: the inversion vouches for a head by name, so a PATH whose new value can
// resolve names to repository files is command-bearing.
describe("R39 — PATH changes that can reach repository files", () => {
  it.each([
    "PATH=./bin:$PATH ls", "PATH=bin:$PATH ls", "PATH=.:$PATH ls", "PATH=:$PATH ls", "PATH=$PATH: ls",
    "PATH=/usr/bin::/bin ls", "PATH=/Users/u/repo/bin:$PATH ls", "PATH=/usr/../tmp:$PATH ls", "PATH=$HOME/bin:$PATH ls",
    "PATH=$(pwd)/bin:$PATH ls", "PATH=~/bin:$PATH ls", "PATH+=:./bin ls",
    "env PATH=./bin ls", "env PATH=./bin:$PATH ls", "export PATH=./bin:$PATH; ls", "declare -x PATH=./bin; ls",
    "typeset -x PATH=./bin; ls", "PATH=./bin:$PATH; ls", "export PATH=\"$PATH:/x\"; ls",
  ])("%s -> PATH", (c) => expect(findDestructiveToken(c)).toBe("PATH"));
  it.each([
    "export PATH=\"$PATH:/usr/local/bin\"; ls", "PATH=/usr/bin:/bin ls", "PATH=/opt/homebrew/bin:$PATH ls",
    "PATH=${PATH}:/usr/sbin ls", "env PATH=/usr/bin:/bin ls", "export PATH=/nix/store/abc-x/bin:$PATH; ls",
  ])("%s stays read-only", (c) => expect(findDestructiveToken(c)).toBeNull());
});

// R40: builtins that assign a variable are as command-bearing as `NAME=…` when
// they target a variable that makes a later command run code.
describe("R40 — variable-assigning builtins targeting command-bearing names", () => {
  it.each([
    ["read LESSOPEN < f; less x", "LESSOPEN"],
    ["read -r a PAGER < f", "PAGER"],
    ["read -a NODE_OPTIONS < f", "NODE_OPTIONS"],
    ["mapfile NODE_OPTIONS < f", "NODE_OPTIONS"],
    ["readarray -t LD_PRELOAD < f", "LD_PRELOAD"],
    ["getopts x PATH", "PATH"],
    ["printf -v PAGER '%s' x", "PAGER"],
    ["printf -vGIT_PAGER x", "GIT_PAGER"],
    ["declare -x GIT_PAGER", "GIT_PAGER"],
    ["read $name < f", "read dynamic variable"],
    ["printf -v \"$n\" x", "printf dynamic variable"],
  ])("%s -> %s", (c, token) => expect(findDestructiveToken(c)).toBe(token));
  it.each(["read -r line < f", "read -p 'Name: ' x", "mapfile -t arr < f", "getopts ab opt", "printf -v out '%s' x",
    "while read -r a b; do echo $a; done < f"])("%s stays read-only", (c) => expect(findDestructiveToken(c)).toBeNull());
});
