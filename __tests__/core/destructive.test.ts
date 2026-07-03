import { describe, expect, it } from "vitest";
import {
  effectiveHead,
  findDestructiveToken,
  isDestructiveCommand,
  splitCommandSegments,
} from "../../core/destructive.ts";

describe("isDestructiveCommand — heuristic coverage (2026-07 audit)", () => {
  // Writers the audit found the blocklist missing. Every one must be caught.
  const writers = [
    "sed -i s/a/b/ f",
    "sed -e x -i f",
    "tee out.log",
    "wget http://x/f",
    "curl -o out http://x",
    "curl -sO http://x",
    "find . -name x -delete",
    "touch marker",
    "mkdir -p build",
    "ln -sf a b",
    "kill -9 1234",
    "pkill -f node",
    "killall node",
    "shred secrets.txt",
    "unlink f",
    "crontab jobs.txt",
    "git stash drop",
    "git stash pop",
    "git rebase main",
    "git restore f",
    "git switch main",
    "git merge feature",
    "git cherry-pick abc123",
    "git revert HEAD",
    'bash -c "rm -rf x"',
    "echo hi >> log",
  ];
  it.each(writers)("catches writer: %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(true);
  });

  // Reads that must NOT be blocked — incl. the stdout-mode / list-mode guards
  // and quoted comparisons.
  const reads = [
    'grep "a->b" src/x.ts',
    'grep "x > 5" log.txt',
    "wget -qO- http://x",
    "wget -O- http://x",
    "wget -O - http://x",
    "crontab -l",
    "curl http://x",
    "curl -s http://x",
    "curl -fsSL http://x",
    "git status",
    "git stash list",
    "git log --oneline",
    "sed s/a/b/ f",
    "sed -n 5p f",
    "find . -name x",
    "cat f",
    "ls foo 2>/dev/null || echo missing",
    "cat bar 2>&1",
    "grep foo bar > /dev/null || echo none",
  ];
  it.each(reads)("does not block read: %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(false);
  });

  it("destructive word inside DOUBLE quotes is still caught (only angles are dropped)", () => {
    expect(isDestructiveCommand('sh -c "rm -rf /tmp/x"')).toBe(true);
    expect(isDestructiveCommand("sh -c 'rm -rf /tmp/x'")).toBe(true);
  });
});

describe("safe tier — pure-reader heads skip the word scan", () => {
  // THE false-positive fix: searching a codebase for writer words is a read.
  const quotedWriterSearches = [
    'grep "rm -rf /" src/',
    'grep -rn "npm install" docs/',
    "rg 'git push --force' .",
    'grep "sudo rm" README.md',
    "cat notes.md | grep 'mkdir'",
    'echo "use rm -rf carefully"',
    "jq '.scripts.install' package.json",
  ];
  it.each(quotedWriterSearches)("allows quoted-writer search: %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(false);
  });

  it("redirects still stop allowlisted heads", () => {
    expect(isDestructiveCommand("cat f > out")).toBe(true);
    expect(isDestructiveCommand('grep "x" f > hits.txt')).toBe(true);
  });

  it("a non-allowlisted head anywhere in the pipeline restores the word scan", () => {
    expect(isDestructiveCommand("cat f | tee g")).toBe(true);
    expect(isDestructiveCommand("cat f && rm f")).toBe(true);
  });

  it("subshell content disqualifies the safe tier", () => {
    expect(isDestructiveCommand('echo "$(rm -rf x)"')).toBe(true);
    expect(isDestructiveCommand("cat `rm x`")).toBe(true);
  });

  it("head exceptions force the full scan: sed -i, sort -o, awk system(), find -exec rm", () => {
    expect(isDestructiveCommand("sed -i s/a/b/ f")).toBe(true);
    expect(isDestructiveCommand("sort -o f f")).toBe(true);
    expect(isDestructiveCommand("awk 'BEGIN{system(\"rm x\")}' f")).toBe(true);
    expect(isDestructiveCommand("find . -exec rm {} \\;")).toBe(true);
    // ... but the read-only uses of the same heads stay allowed
    expect(isDestructiveCommand("sort -r f")).toBe(false);
    expect(isDestructiveCommand("awk '{print $1}' f")).toBe(false);
    expect(isDestructiveCommand("find . -exec grep pat {} \\;")).toBe(false);
  });

  it("env-var prefixes and path heads resolve to the underlying command", () => {
    expect(isDestructiveCommand('FOO=1 grep "rm -rf" f')).toBe(false);
    expect(isDestructiveCommand('/usr/bin/grep "rm -rf" f')).toBe(false);
  });

  it("wrappers defer to what they run: xargs/time/nohup", () => {
    expect(isDestructiveCommand("xargs rm")).toBe(true);
    expect(isDestructiveCommand("find . -name x | xargs rm")).toBe(true);
    expect(isDestructiveCommand("time cat f")).toBe(false);
  });

  it("sudo is never allowlisted", () => {
    expect(isDestructiveCommand('sudo cat /etc/shadow > /dev/null && sudo rm x')).toBe(true);
  });
});

describe("interpreter eval — fs-writer APIs are caught", () => {
  const evalWriters = [
    `node -e "require('fs').writeFileSync('x','y')"`,
    `node -e "fs.rmSync('x')"`,
    `python -c "open('f','w').write('x')"`,
    `python3 -c "import os; os.remove('f')"`,
    `python -c "import shutil; shutil.rmtree('d')"`,
    `node --eval "fs.mkdirSync('d')"`,
  ];
  it.each(evalWriters)("catches eval writer: %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(true);
  });

  const evalReaders = [
    `node -e "console.log(process.version)"`,
    `node -e "const t = require('./package.json'); console.log(t.name)"`,
    `python -c "print(2+2)"`,
    `python3 -c "import json,sys; print(json.load(open('f'))['a'])"`,
  ];
  it.each(evalReaders)("allows eval reader: %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(false);
  });

  it("a plain script invocation (no eval flag) keeps status-quo scanning", () => {
    expect(isDestructiveCommand("node scripts/report.js")).toBe(false);
    expect(isDestructiveCommand("pnpm test")).toBe(false);
    expect(isDestructiveCommand("tsc --noEmit")).toBe(false);
  });
});

describe("splitCommandSegments", () => {
  it("splits on unquoted |, ;, &&, ||", () => {
    expect(splitCommandSegments("a | b && c ; d || e")).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not split inside quotes", () => {
    expect(splitCommandSegments(`grep "a|b" f`)).toEqual([`grep "a|b" f`]);
    expect(splitCommandSegments("awk '{print $1; print $2}' f")).toEqual(["awk '{print $1; print $2}' f"]);
  });

  it("does not split fd dups (2>&1)", () => {
    expect(splitCommandSegments("cmd 2>&1")).toEqual(["cmd 2>&1"]);
  });

  it("splits background joins (&)", () => {
    expect(splitCommandSegments("a & b")).toEqual(["a", "b"]);
  });

  it("degenerate input returns the whole command", () => {
    expect(splitCommandSegments("")).toEqual([""]);
  });
});

describe("effectiveHead", () => {
  it("skips env prefixes, resolves paths, defers wrappers", () => {
    expect(effectiveHead("FOO=1 BAR=2 cat f")).toBe("cat");
    expect(effectiveHead("/usr/bin/grep x f")).toBe("grep");
    expect(effectiveHead("xargs rm")).toBe("rm");
    expect(effectiveHead("time nice cat f")).toBe("cat");
    expect(effectiveHead("sudo cat f")).toBe("sudo");
    expect(effectiveHead("")).toBe(null);
  });
});

describe("findDestructiveToken — token reporting", () => {
  it("names the token that tripped the stop", () => {
    expect(findDestructiveToken("tee out.log")).toContain("tee");
    expect(findDestructiveToken("echo x > f")).toBe(">");
    expect(findDestructiveToken(`node -e "fs.writeFileSync('x','y')"`)).toContain("writeFileSync");
  });
});
