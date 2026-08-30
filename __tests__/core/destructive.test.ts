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

  it.each([
    "if true; then mkdir /tmp/x; fi",
    "if false; then :; elif true; then mkdir /tmp/x; fi",
    "if true; then :; else mkdir /tmp/x; fi",
    "while true; do mkdir /tmp/x; done",
    "until false; do mkdir /tmp/x; done",
    "for item in one two; do mkdir /tmp/x; done",
    "echo $(if true; then mkdir /tmp/x; fi)",
    "case x in a) if true; then mkdir /tmp/x; fi ;; esac",
  ])("finds mutation after non-leading reserved words: %s", (command) => {
    expect(findDestructiveToken(command)).toContain("mkdir");
  });

  it.each([
    "f() { touch /tmp/x; }; f",
    "case x in a) case y in b) touch /tmp/x ;; c) printf ok ;; esac ;; d) echo ok ;; esac",
    "case x in a) case y in b) f(){ touch /tmp/x; }; f ;; esac ;; esac",
    "case x in a) echo ok ;; esac; touch /tmp/x",
  ])("finds mutation inside functions and nested cases: %s", (command) => {
    expect(findDestructiveToken(command)).toContain("touch");
  });

  it.each([
    "case x in orphan ;; a) echo ok ;; esac",
    "case x in a) echo ok ;; orphan ;; esac",
    "case x in a) echo ok ;; orphan esac",
  ])("fails closed for orphan case text: %s", (command) => {
    expect(findDestructiveToken(command)).toBe("complex shell syntax");
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

  const languageWriters = [
    `perl -e "rename('a','b')"`,
    `perl -e "unlink('a')"`,
    `perl -e "open(F, '>', 'out'); print F 'x'; close F"`,
    `perl -e "open my $fh, '>', 'out'; print $fh 'x'"`,
    `ruby -e "File.write('out', 'x')"`,
    `ruby -e "File.delete('out')"`,
    `ruby -e "File.rename('a', 'b')"`,
    `ruby -e "FileUtils.touch('out')"`,
    `ruby -e "FileUtils.rm_rf('out')"`,
    `ruby -e "File.open('out', 'wb') { |f| f.write('x') }"`,
    `php -r "file_put_contents('out', 'x');"`,
    `php -r "unlink('out');"`,
    `php -r "rename('a', 'b');"`,
    `php -r "fopen('out', 'w');"`,
    `php -r "fopen('out', 'a+');"`,
  ];
  it.each(languageWriters)("catches non-obfuscated %s writer", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(true);
  });

  const languageReaders = [
    `perl -e "print 2 + 2"`,
    `perl -e "open(F, '<', 'in'); print <F>"`,
    `ruby -e "puts File.read('in')"`,
    `ruby -e "FileUtils.compare_file('a', 'b')"`,
    `php -r "echo file_get_contents('in');"`,
    `php -r "fopen('in', 'r');"`,
  ];
  it.each(languageReaders)("allows read-only %s interpreter code", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(false);
  });

  // Extended language API coverage is deliberately table-driven so every
  // namespace/mode spelling remains a static regression even when an
  // interpreter is absent from the test host.
  const extendedLanguageWriters = [
    // Ruby File and FileUtils writers, including namespace separators.
    `ruby -e "File::write('out', 'x')"`,
    `ruby -e "File::binwrite('out', 'x')"`,
    `ruby -e "File::delete('out')"`,
    `ruby -e "File::unlink('out')"`,
    `ruby -e "File::rename('a', 'b')"`,
    `ruby -e "File::truncate('out', 0)"`,
    `ruby -e "FileUtils::rm('out')"`,
    `ruby -e "FileUtils.rm_f('out')"`,
    `ruby -e "FileUtils::rm_rf('out')"`,
    `ruby -e "FileUtils.mv('a', 'b')"`,
    `ruby -e "FileUtils::cp('a', 'b')"`,
    `ruby -e "FileUtils.cp_r('a', 'b')"`,
    `ruby -e "FileUtils::mkdir('d')"`,
    `ruby -e "FileUtils.mkdir_p('d')"`,
    `ruby -e "FileUtils::touch('out')"`,
    `ruby -e "FileUtils.ln('a', 'b')"`,
    `ruby -e "FileUtils::ln_s('a', 'b')"`,
    `ruby -e "FileUtils.install('a', 'b')"`,
    `ruby -e "FileUtils::chmod(0o600, 'out')"`,
    `ruby -e "FileUtils.chown(1, 1, 'out')"`,
    `ruby -e "File.open('out', 'rb+') { |f| f.write('x') }"`,
    `ruby -e "File::open('out', 'w') { |f| f.write('x') }"`,
    `ruby -e "File.open('out', 'a') { |f| f.write('x') }"`,
    `ruby -e "File.open('out', 'x') { |f| f.write('x') }"`,
    // Perl open in parenthesized and bare-handle forms, including encoding
    // suffixes, read-write modes, and pipes.
    `perl -e "open(FH, '>:encoding(UTF-8)', 'out')"`,
    `perl -e "open FH, '>>:encoding(UTF-8)', 'out'"`,
    `perl -e "open my \$fh, '+<', 'out'"`,
    `perl -e "open FH, '+>', 'out'"`,
    `perl -e "open FH, '|-', 'touch out'"`,
    `perl -e "open(FH, '| cat')"`,
    `perl -e "sysopen(FH, 'out', O_WRONLY | O_CREAT)"`,
    `perl -e "sysopen FH, 'out', O_RDWR | O_TRUNC"`,
    `perl -e "rename('a', 'b')"`,
    `perl -e "unlink('out')"`,
    `perl -e "truncate('out', 0)"`,
    `perl -e "mkdir('d')"`,
    `perl -e "rmdir('d')"`,
    `perl -e "chmod(0600, 'out')"`,
    `perl -e "chown(1, 1, 'out')"`,
    `perl -e "link('a', 'b')"`,
    `perl -e "symlink('a', 'b')"`,
    // PHP function names are case-insensitive and all listed mutators count.
    `php -r "FWRITE(\$fh, 'x');"`,
    `php -r "Fputs(\$fh, 'x');"`,
    `php -r "FILE_PUT_CONTENTS('out', 'x');"`,
    `php -r "UnLiNk('out');"`,
    `php -r "ReNaMe('a', 'b');"`,
    `php -r "CoPy('a', 'b');"`,
    `php -r "ToUcH('out');"`,
    `php -r "MkDiR('d');"`,
    `php -r "RmDiR('d');"`,
    `php -r "ChMoD('out', 0600);"`,
    `php -r "ChOwN('out', 1);"`,
    `php -r "LiNk('a', 'b');"`,
    `php -r "SyMlInK('a', 'b');"`,
    `php -r "MoVe_UpLoAdEd_FiLe('a', 'b');"`,
    `php -r "fopen('out', 'rb+');"`,
    `php -r "FOPEN('out', 'w');"`,
    `php -r "fopen('out', 'a');"`,
    `php -r "fopen('out', 'x');"`,
    `php -r "fopen('out', 'c');"`,
  ];
  it.each(extendedLanguageWriters)("catches extended interpreter writer %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(true);
  });

  const extendedLanguageReaders = [
    `ruby -e "File.read('in')"`,
    `ruby -e "File.open('in', 'rb') { |f| f.read }"`,
    `ruby -e "FileUtils.compare_file('a', 'b')"`,
    `perl -e "open(FH, '<', 'in'); print <FH>"`,
    `perl -e "open FH, '<:encoding(UTF-8)', 'in'"`,
    `perl -e "sysopen(FH, 'in', O_RDONLY)"`,
    `php -r "file_get_contents('in');"`,
    `php -r "fopen('in', 'r');"`,
    `php -r "FOPEN('in', 'rb');"`,
    `ruby -e "puts 'File.write(\'out\', \'x\')' # FileUtils.rm_rf(\'d\')"`,
    `perl -e "print '# open FH, \">\", \\"out\\"'; # unlink('out')"`,
    `php -r "echo 'file_put_contents(\'out\', \'x\')'; // unlink('out');"`,
  ];
  it.each(extendedLanguageReaders)("allows extended interpreter read/data %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(false);
  });

  const rubyFileUtilsAliasWriters = [
    `ruby -e "FileUtils.rm_r('out')"`,
    `ruby -e "FileUtils::remove_entry('out')"`,
    `ruby -e "FileUtils.remove_entry_secure('out')"`,
    `ruby -e "FileUtils.rmtree('out')"`,
    `ruby -e "FileUtils.safe_unlink('out')"`,
    `ruby -e "FileUtils.ln_sf('a', 'b')"`,
    `ruby -e "FileUtils.chmod_R(0o600, 'out')"`,
    `ruby -e "FileUtils::chown_R(1, 1, 'out')"`,
    `ruby -e "FileUtils.copy('a', 'b')"`,
    `ruby -e "FileUtils.copy_entry('a', 'b')"`,
    `ruby -e "FileUtils.copy_file('a', 'b')"`,
    `ruby -e "FileUtils.copy_stream('a', 'b')"`,
    `ruby -e "FileUtils.cp_lr('a', 'b')"`,
    `ruby -e "FileUtils.move('a', 'b')"`,
    `ruby -e "FileUtils.makedirs('d')"`,
    `ruby -e "FileUtils.mkpath('d')"`,
    `ruby -e "FileUtils.link('a', 'b')"`,
    `ruby -e "FileUtils.link_entry('a', 'b')"`,
    `ruby -e "FileUtils.symlink('a', 'b')"`,
    `ruby -e "FileUtils.remove_file('out')"`,
    `ruby -e "FileUtils.remove_dir('out')"`,
  ];
  it.each(rubyFileUtilsAliasWriters)("catches Ruby FileUtils alias writer %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(true);
  });

  it.each([
    `ruby -e "FileUtils.pwd"`,
    `ruby -e "FileUtils.uptodate?('a', 'b')"`,
    `ruby -e "FileUtils.compare_file('a', 'b')"`,
  ])("keeps benign Ruby FileUtils query %s read-only", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(false);
  });

  it.each([
    `perl -e "sysopen(FH, 'in', O_RDONLY); print O_TRUNC"`,
    `perl -e "sysopen(FH, 'in', O_RDONLY); print 'O_WRONLY O_CREAT O_TRUNC'"`,
    `perl -e "sysopen(FH, 'in', O_RDONLY); # O_TRUNC O_WRONLY"`,
    `perl -e "sysopen FH, 'in', O_RDONLY # O_TRUNC\n"`,
  ])("keeps Perl sysopen reader flags/data safe %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(false);
  });

  it.each([
    `perl -e "sysopen(FH, 'out', O_TRUNC)"`,
    `perl -e "sysopen FH, 'out', O_WRONLY | O_CREAT"`,
    `perl -e "sysopen(FH, 'out', O_CREAT | O_RDONLY)"`,
    `perl -e "sysopen(FH, 'out', O_RDONLY | O_TRUNC)"`,
    `perl -e "sysopen FH, 'out', O_RDWR | O_APPEND"`,
  ])("catches Perl sysopen writer flags %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(true);
  });

  it.each([
    `perl -e "print 'rename(\\'a\\',\\'b\\')'"`,
    `perl -e "print 'sysopen(FH, \\'in\\', O_TRUNC)'"`,
  ])("masks Perl single-quoted printed code %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(false);
  });

  it.each([
    `php -r "# file_put_contents('out', 'x')\necho 'ok';"`,
    `php -r "echo 'file_put_contents(\\'out\\', \\'x\\')'; // unlink('out');"`,
    `php -r "/* rename('a', 'b'); fopen('out', 'w'); */ echo 'ok';"`,
    `php -r "fopen('in', 'r'); echo 'fopen(\\'out\\', \\'w\\')';"`,
  ])("keeps PHP writer-looking strings/comments safe %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(false);
  });

  it.each([
    `php -r "\\unlink('out');"`,
    `php -r "Namespace\\rename('a', 'b');"`,
    `php -r "\\NS\\fopen('out', 'w');"`,
    `php -r "# harmless\n\\NS\\FOPEN('out', 'w');"`,
  ])("catches PHP namespaced/case-insensitive writer %s", (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(true);
  });
});

describe("splitCommandSegments", () => {
  it("splits on unquoted |, ;, &&, ||", () => {
    expect(splitCommandSegments("a | b && c ; d || e")).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not split inside quotes", () => {
    expect(splitCommandSegments(`grep "a|b" f`)).toEqual([`grep "a|b" f`]);
    expect(splitCommandSegments("awk '{print $1; print $2}' f")).toEqual(["awk '{print $1; print $2}' f"]);
    expect(splitCommandSegments('git grep "one\ntwo" -- README.md')).toEqual(['git grep "one\ntwo" -- README.md']);
  });

  it("splits newline and CRLF command separators", () => {
    expect(splitCommandSegments("git status\ngit add file.txt")).toEqual(["git status", "git add file.txt"]);
    expect(splitCommandSegments("git status\r\ngit add file.txt")).toEqual(["git status", "git add file.txt"]);
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

describe("mutation classifier — ordinary copy and git verbs", () => {
  it.each([
    "cp source.txt destination.txt",
    "cp -- source.txt destination.txt",
    "git add file.txt",
    "git clone https://example.invalid/repo target",
    "git fetch origin",
    "git pull --ff-only",
    "git init scratch",
  ])("blocks mutating command: %s", (command) => {
    expect(findDestructiveToken(command)).not.toBeNull();
  });

  it.each([
    "git status --short",
    "git diff --stat",
    "git log -5 --oneline",
    "git show HEAD:README.md",
    "git rev-parse --show-toplevel",
    "git branch --list",
    "git tag --list",
    "git remote -v",
    "git config --get user.name",
  ])("allows read-only git command: %s", (command) => {
    expect(findDestructiveToken(command)).toBeNull();
  });

  it.each([
    "git -C /repo status",
    "git -c core.pager=cat diff",
    "git --git-dir /repo/.git log -5",
    "git --no-pager show HEAD:README.md",
    'git grep "rm -rf /" -- README.md',
    "git status | grep 'cp source destination'",
  ])("allows read-only git command with options or quoted patterns: %s", (command) => {
    expect(findDestructiveToken(command)).toBeNull();
  });
});

describe("mutation classifier — wrapper options and command separators", () => {
  it.each([
    "env -i git add file.txt",
    "env -- git clone https://example.invalid/repo target",
    "env -u GIT_CONFIG_NOSYSTEM git fetch origin",
    "env -iu GIT_CONFIG_NOSYSTEM git init scratch",
    "env -uX git init scratch",
    "env --unset X git init scratch",
    "env --unset=X git init scratch",
    "env -S \"git add file.txt\"",
    "env -iS\"git add file.txt\"",
    "command -p git pull --ff-only",
    "xargs -n 1 git init scratch",
  ])("blocks Git mutation behind wrapper options: %s", (command) => {
    expect(findDestructiveToken(command)).not.toBeNull();
  });

  it.each([
    "env -i git status --short",
    "env -- git diff --stat",
    "env -u GIT_CONFIG_NOSYSTEM git log -5 --oneline",
    "env -S \"git status --short\"",
    "command -p git show HEAD:README.md",
  ])("allows read-only Git behind wrapper options: %s", (command) => {
    expect(findDestructiveToken(command)).toBeNull();
  });

  it.each([
    "git status\ngit add file.txt",
    "git status\r\ngit add file.txt",
  ])("blocks a mutating Git command after a newline: %s", (command) => {
    expect(findDestructiveToken(command)).not.toBeNull();
  });

  it("keeps quoted newlines inside one read-only command", () => {
    expect(findDestructiveToken('git grep "status\ngit add file.txt" -- README.md')).toBeNull();
  });

  it.each([
    "/usr/bin/time -o timing.log printf hi",
    "time --output timing.log printf hi",
    "time -ofile printf hi",
    "time --output=file printf hi",
    "env -u X /usr/bin/time -o timing.log printf hi",
    "nice -n 5 /usr/bin/time -o timing.log printf hi",
    "env time -o timing.log printf hi",
    "env time --output=file printf hi",
    "time -a -o timing.log printf hi",
    "time -a --output timing.log printf hi",
    "time -ao timing.log printf hi",
    "env -iS\"/usr/bin/time -o timing.log printf hi\"",
    "env --split-string=\"/usr/bin/time -o timing.log printf hi\"",
  ])("blocks time output files before resolving the inner command: %s", (command) => {
    expect(findDestructiveToken(command)).not.toBeNull();
  });

  it.each([
    "time -p printf hi",
    "time -f %E printf hi",
    "time --format %E printf hi",
    "env time -p printf hi",
  ])("keeps non-output time wrappers safe: %s", (command) => {
    expect(findDestructiveToken(command)).toBeNull();
  });

  it.each([
    "( /usr/bin/time -o timing.log printf hi )",
    "( cp source.txt destination.txt )",
    "( git add file.txt )",
    "{ git init scratch; }",
    "{ cp source.txt destination.txt; }",
    "if git init scratch; then :; fi",
    "if /usr/bin/time -o timing.log printf hi; then :; fi",
  ])("inspects commands inside a parenthesized group: %s", (command) => {
    expect(findDestructiveToken(command)).not.toBeNull();
  });

  it.each([
    "( time -p printf hi )",
    "printf '( /usr/bin/time -o timing.log printf hi )'",
    "{ git status; }",
    "if git status; then :; fi",
    "printf '{ git init scratch; }'",
  ])("does not treat safe or quoted parentheses as mutations: %s", (command) => {
    expect(findDestructiveToken(command)).toBeNull();
  });

  it.each([
    'echo "$(git init scratch)"',
    'echo "$(/usr/bin/time -o timing.log printf hi)"',
    'echo "$(git add file.txt)"',
    "echo `git init scratch`",
  ])("recursively inspects command substitutions: %s", (command) => {
    expect(findDestructiveToken(command)).not.toBeNull();
  });

  it.each([
    'echo "$(git status)"',
    "echo '$(git init scratch)'",
    "printf '`git init scratch`'",
  ])("preserves read-only and literal substitutions: %s", (command) => {
    expect(findDestructiveToken(command)).toBeNull();
  });

  it("fails closed for executable substitutions whose syntax is incomplete", () => {
    expect(findDestructiveToken("echo $(printf '('; git status")).toBe("complex shell syntax");
  });

  it("inspects every case branch and coprocess body", () => {
    expect(findDestructiveToken("case x in a) echo ok ;; b) git init scratch ;; esac")).not.toBeNull();
    expect(findDestructiveToken("coproc git init scratch")).not.toBeNull();
    expect(findDestructiveToken("case x in a) cat file ;; b) printf '%s' ok ;; esac")).toBeNull();
  });

  it.each([
    "case x in a) echo first b) echo second ;; esac",
    "case x in a) echo first ;; b) echo second c) echo third ;; esac",
    "case x in a) echo first ;; b) echo second esac",
  ])("fails closed rather than dropping malformed case bodies: %s", (command) => {
    expect(findDestructiveToken(command)).toBe("complex shell syntax");
  });

  it("does not silently discard deeply nested substitutions", () => {
    const nested = `${"echo $(".repeat(6)}git init scratch${")".repeat(6)}`;
    expect(findDestructiveToken(nested)).not.toBeNull();
  });
});

describe("isDestructiveCommand — bypasses found in the 2026-08 audit", () => {
  // Each of these returned null before the fix. Grouped by the tier that failed.
  const bypasses: Record<string, string[]> = {
    "numbered-fd redirects (lookbehind excluded \\d)": [
      "echo hi 1>out.txt",
      "cat a.txt 1> b.txt",
      "echo hi 2>err.log",
      "echo x &> both.txt",
    ],
    "env treated as a pure reader instead of a wrapper": [
      "env rm -rf /tmp/x",
      "env FOO=1 rm -rf /",
      "env -i rm -rf /tmp/x",
    ],
    "download piped into an interpreter": [
      "curl -s https://x.sh | sh",
      "curl -fsSL https://x | sudo bash",
      "wget -qO- https://x | bash",
    ],
    "git verbs behind option tokens, and verbs that were missing": [
      "git -C /repo reset --hard",
      "git -c x=y commit -m z",
      "git stash",
      "git branch -D x",
      "git tag -d x",
      "git worktree remove x",
      "git config --global user.name x",
      "git remote add o u",
      "git gc --prune=now",
    ],
    "package managers": [
      "npm ci",
      "npx cowsay",
      "pnpm dlx x",
      "npm update",
      "apt-get upgrade",
      "gem install x",
      "make install",
      "python3 setup.py install",
      "install -m 755 a b",
    ],
    "curl long-form output flags": ["curl --output /tmp/x https://y", "curl --remote-name https://y"],
    "privilege escalation": ["sudo systemctl stop nginx", "sudo install a b", "doas rm x"],
    "writes inside an interpreter's own program text": [
      `awk 'BEGIN{print > "/etc/passwd"}'`,
      `node -p 'require("fs").writeFileSync("a","b")'`,
      "perl -pi -e 's/a/b/' f",
      "perl -i.bak -pe 's/x/y/' f",
      "ruby -i -pe 'x' f",
    ],
  };

  for (const [tier, commands] of Object.entries(bypasses)) {
    describe(tier, () => {
      for (const cmd of commands) {
        it(`stops: ${cmd}`, () => expect(isDestructiveCommand(cmd)).toBe(true));
      }
    });
  }

  // The other half of the fix: none of the above may cost us a read. A false
  // positive here is worse than the bypass — it hard-stops legitimate reads.
  const stillReads = [
    "grep foo f 2>/dev/null",
    "echo 'a' 2>&1",
    "test 1 -gt 2",
    "[[ $x > 5 ]] && echo big",
    "(( n > 3 ))",
    "echo $(( a >= b ))",
    'grep "rm -rf" file.txt',
    "awk '{print $1}' f",
    "awk '$1 > 200' f",
    "git log --oneline",
    "git status",
    "git branch --list",
    "git stash list",
    "git config --get user.name",
    "git remote -v",
    "git tag -l",
    "wget -qO- https://x",
    "env",
    "printenv PATH",
    "node --version",
    "find . -name '*.ts'",
    "sed -n '1,5p' f",
  ];
  for (const cmd of stillReads) {
    it(`still reads: ${cmd}`, () => expect(isDestructiveCommand(cmd)).toBe(false));
  }
});
