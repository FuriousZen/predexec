import { describe, expect, it } from "vitest";
import { isDestructiveCommand } from "../../core/index.ts";

// CORE-1: heads in READ_ONLY_HEADS skip the word scan, so every write/exec
// form they support must be caught by that head's argv predicate instead.
// `jq -n 'input' --rawfile x /dev/stdin` is deliberately absent: per the jq
// manual, --rawfile/--slurpfile/input only read, and jq has no builtin that
// writes a file or runs a program.
const ESCAPES = [
  "sed -n 'w SED_W.txt' in.txt", "sed -n 'W out' f", "sed '1e touch x' f", "sed --in-place s/a/b/ f",
  "sed -Ei s/a/b/ f", "sed -ni.bak p f", "sort --output=o.txt f", "sort -oo.txt f", "sort -o o.txt f",
  "sort --compress-program=sh f", "awk 'BEGIN{print \"x\" | \"sh\"}'", "awk 'BEGIN{\"touch x\" | getline}'",
  "awk '{print > \"f\"}' in", "gawk -i inplace '{print}' f", "xxd in.txt out.txt", "xxd -r a b",
  "rg --pre ./x.sh hello f", "rg --pre=./x.sh hello f", "tree -o out.txt", "find . -fprint out",
  "find . -fls out", "find . -fprintf out %p", "find . -okdir rm {} ;", "find . -delete",
  "less -o log f", "less --log-file=log f", "yq -i .a=1 f.yaml",
  // less reads options and input preprocessors from its environment too.
  "LESSOPEN='|cmd' less f", `LESSOPEN="||cmd %s" less f`, "LESS=-olog less f", "LESS='-O log' less f",
  "env LESSOPEN='|cmd' less f", "env LESS=-olog less f", "LESSCLOSE='cmd %s %s' less f",
];

// Further write/exec spellings of the same heads, beyond the audit's list.
const MORE_ESCAPES = [
  // sed: s/// flags, -e/--expression scripts, abbreviated long options, script files
  "sed 's/a/b/w out' f", "sed 's/a/b/e' f", "sed -e p -e 'w out' f", "sed --expression='1e id' f",
  "sed --in s/a/b/ f", "sed -i.bak s/a/b/ f", "sed -f script.sed f", "sed '/x/{w out\n}' f",
  "sed '$!N;w out' f", "sed 's|a|b|gw out' f",
  // sort: abbreviated long options
  "sort --out=o.txt f", "sort --compress=sh f", "sort -ro o.txt f",
  // awk: pipes to a command variable, coprocesses, system(), program files, dump/profile files
  "awk '{print | cmd}' f", "gawk '{print |& \"sh\"}' f", "awk 'BEGIN{system(\"id\")}'", "awk -f prog.awk f",
  "gawk --include=inplace '{print}' f", "gawk -o '{print}' f", "gawk --profile '{print}' f",
  "awk '{printf \"%s\", $1 >> \"f\"}' f", "mawk '{print > \"f\"}' f", "awk -- '{print > \"f\"}' f",
  "gawk -e '{print > \"f\"}' f", "gawk '@load \"filefuncs\"; BEGIN{}'",
  // xxd: long spellings of -r, positional output after options
  "xxd -revert a b", "xxd -l 32 in out", "xxd -- in out",
  // rg: hostname-bin executes a program
  "rg --hostname-bin=./x.sh foo", "rg --pre-glob '*' --pre ./x.sh foo",
  // tree: clustered -o, -R writes 00Tree.html per directory
  "tree -ao out.txt", "tree -R -H . ",
  // find: exec forms inspected recursively; found files as the command
  "find . -exec rm {} \\;", "find . -execdir sh -c 'rm \"$1\"' _ {} \\;", "find . -exec {} \\;",
  "find . -ok rm {} +", "find . -name x -fprint0 out",
  // less: clustered -o, log-file abbreviations
  "less -So log f", "less -Olog f", "less --LOG-FILE=log f", "less --log=log f",
  // less: +cmd initial commands (`!` runs a shell), also via $LESS
  "less '+!touch x' f", "less '+|touch x' f", "LESS='+!touch x' less f", "LESS=So less f",
  "less \"+/x\n!touch y\" f", "LESSKEY_CONTENT='#env LESSOPEN=|touch' less f",
  // yq: in-place and split-exp
  "yq --inplace .a=1 f.yaml", "yq -Pi .a=1 f.yaml", "yq --split-exp .a f.yaml", "yq -s .a f.yaml",
  // review round 1: dynamic find -exec payloads, gawk indirect calls, find
  // options after an escaped `;` that the segment splitter cuts off
  "find . -exec sh -c \"$CMD\" \\;", "find . -exec sh -c \"$CMD\" {} +", "find . -exec sh -c \"`id`\" \\;",
  "gawk 'BEGIN{f=\"system\"; @f(\"id\")}'", "awk 'BEGIN{@f()}'",
  "find . -exec grep x {} \\; -delete", "find . -exec grep x {} \\; -fprint out",
  "find . -exec grep x {} \\; -fls out", "find . -exec grep x {} \\; -fprintf out %p", "find . -exec grep x {}",
  // wrappers resolve to the same heads
  "xargs sed -i s/a/b/", "env LC_ALL=C sort -o o.txt f",
];

const SAFE = [
  "sed -n 1,5p f", "sort -r f", "awk '{print $1}' f", "xxd f", "rg hello", "tree -L 2", "find . -name '*.ts'",
  "less f", "yq .a f.yaml",
];

const MORE_SAFE = [
  "sed -n '/w/p' f", "sed 's/a/w/g' f", "sed -e s/a/b/ -e 's/x/y/' f", "sed -E 's/(a|b)/c/g' f",
  "sed -n '/start/,/end/p' f", "sed '1i hello' f", "sed '/x/a appended; w not-a-command' f",
  "sed -n '$p' f", "sed 'y/abc/xyz/' f", "sed -n 's/a/b/gp' f", "sed '/re/I d' f",
  "sort -t, -k2 f", "sort -T /tmp -S 1M f", "sort --reverse f",
  "awk '/a|b/' f", "awk '$1 > 200' f", "awk -v x=1 '{print x}' f", "awk -F: '{print $1}' /etc/passwd",
  "awk '{print \"a>b|c\"}' f", "awk 'NR > 1 && $2 != \"\" {print $2}' f", "awk '$1 || $2' f",
  "xxd -l 32 f", "xxd -c 16 -g 1 f", "xxd -p f", "xxd -",
  "rg --pre-glob '*.gz' foo", "tree -a -I node_modules", "tree -d",
  "find . -exec grep pat {} \\;", "find . -name '*.ts' -exec wc -l {} +", "find . -type f -print", "find . -exec grep x {} \\; | head", "find . -exec grep x {} \\; && echo done",
  "gawk '@namespace \"x\"; BEGIN{print 1}'",
  "less -S f", "less -N --line-numbers f", "less +G f", "less +F f", "less '+/pattern' f", "less +100 f",
  "LESS=FRX less f", "LESS=-R less f", "yq -o=json .a f.yaml", "yq -P .a f.yaml", "jq -n 'input' --rawfile x /dev/stdin",
];

describe("read-only heads that write or exec (CORE-1)", () => {
  it.each(ESCAPES)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(MORE_ESCAPES)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(SAFE)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
  it.each(MORE_SAFE)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});
