import { describe, expect, it } from "vitest";
import { isDestructiveCommand } from "../../core/index.ts";
import { findDestructiveToken } from "../../core/destructive.ts";

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
  "less -k keys f", "less --lesskey-file=keys f", "less --lesskey-src=keys f", "less -kkeys f",
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

// Final review minor #4: ordinary writers the blocklist missed. Each extracts,
// creates, rewrites or records a file; their list/test/stdout modes only read.
const WRITER_ESCAPES = [
  // tar: create/extract/update/append modes, old-style bundles and long forms
  "tar xf a.tar", "tar xvf a.tar", "tar -xf a.tar", "tar -xzf a.tgz", "tar cf out.tar dir", "tar -czf out.tgz dir",
  "tar uf a.tar f", "tar rf a.tar f", "tar --extract -f a.tar", "tar --create -f o.tar d", "tar --get -f a.tar",
  "tar -tf a.tar --to-command=sh", "tar -I 'sh -c id' -tf a.tar", "tar --use-compress-program=x -tf a.tar",
  "tar -tf a.tar --remove-files", "tar --ext -f a.tar", "bsdtar -xf a.tar",
  // unzip: anything but list/test/pipe/comment/zipinfo extracts
  "unzip a.zip", "unzip -o a.zip", "unzip a.zip -d out", "unzip -q a.zip",
  // compressors: in-place by default
  "gzip f", "gzip -9 f", "gunzip f.gz", "gzip -d f.gz", "bzip2 f", "bunzip2 f.bz2", "xz f", "unxz f.xz",
  "zstd f", "zstd -d f.zst", "zstd -c f -o out.zst", "zstd --rm -c f",
  // uniq writes its second operand
  "uniq in.txt out.txt", "uniq -c in.txt out.txt", "uniq -f 1 in.txt out.txt",
  // patch applies unless --dry-run
  "patch < p.diff", "patch -p1 < p.diff", "patch f p.diff", "patch -p1 -i p.diff",
  // sqlite3 and script always may write
  "sqlite3 db.sqlite 'drop table t'", "sqlite3 db.sqlite .tables", "script -q out.txt ls", "script",
  // watch runs its command (sh -c on the joined words, or exec with -x)
  "watch 'echo > x'", "watch -n 1 rm -rf zz", "watch -x rm zz", "watch -n1 'touch x'", "watch --shotsdir=d ls",
  "watch -s d ls", "watch --bogus ls",
];

const WRITER_SAFE = [
  "tar tf a.tar", "tar -tf a.tar", "tar -tvf a.tar", "tar --list -f a.tar", "tar -tzf a.tgz",
  "unzip -l a.zip", "unzip -t a.zip", "unzip -v a.zip", "unzip -p a.zip f", "unzip -qql a.zip", "unzip -Z a.zip",
  "gzip -c f", "gzip -dc f.gz", "gzip -t f.gz", "gzip -l f.gz", "gunzip -c f.gz", "gzip --stdout f",
  "bzip2 -dc f.bz2", "xz -dc f.xz", "xz -l f.xz", "zstd -dc f.zst", "zstd -t f.zst", "zstd --list f.zst",
  "cat f | gzip | wc -c", "zstd --test f.zst", "bunzip2 -c f.bz2", "unxz --stdout f.xz",
  "uniq in.txt", "uniq -c in.txt", "uniq -f 1 in.txt", "sort f | uniq -c",
  "patch --dry-run -p1 < p.diff", "patch --dry-run f p.diff",
  "watch ls", "watch -n 2 'git status'", "watch -x ls -la", "watch -d -n 1 cat f",
];

describe("ordinary writers (final review minor #4)", () => {
  it.each(WRITER_ESCAPES)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(WRITER_SAFE)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});

// E-A: arithmetic contexts evaluate a variable's value as an expression, so a
// value derived from data within the command can run a command substitution.
const TAINTED_ARITHMETIC = [
  "c=$(cat f); echo $((c))", "c=`cat f`; (( c ))", "read c < f; let c", "read -r c <<< \"$x\"; echo $((c+1))",
  "mapfile -t a < f; echo ${a[0]}; echo $((a))", "printf -v c '%s' \"$(cat f)\"; echo ${s:c:1}",
  "for c in $(cat f); do echo $((c)); done", "c=$(cat f); d=$c; echo $((d))", "c=$(cat f); [[ c -eq 1 ]]",
  "c=$(cat f); declare -i n=c", "c=$(cat f); echo ${arr[c]}", "c=$(cat f); echo $(( $c ))",
  "c=$(cat f); echo \"$(( c * 2 ))\"",
  // the rule also runs on a shell's -c payload
  "bash -c 'read c; echo $((c))'", "sh -c 'c=$(cat f); echo $((c))'",
  // an unquoted heredoc body expands arithmetic too
  "c=$(cat f)\ncat <<EOF\n$((c))\nEOF",
];

const UNTAINTED_ARITHMETIC = [
  "x=5; echo $((x+1))", "echo $((3*4))", "echo $((RANDOM % 10))", "n=$(wc -l < f); echo \"$n\"", "echo ${#arr[@]}",
];

describe("arithmetic over data-derived variables (E-A)", () => {
  it.each(TAINTED_ARITHMETIC)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(UNTAINTED_ARITHMETIC)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});

// R5: a data-derived value used as a variable name (verified live on bash 3.2 and sh).
const TAINTED_NAMES = [
  "c=$(cat f); echo ${!c}", "c=$(cat f); [[ -v $c ]]", "c=$(cat f); printf -v \"$c\" x", "c=$(cat f); read \"$c\" <<< x",
  "c=$(cat f); declare \"$c=1\"", "c=$(cat f); export \"$c=1\"", "c=$(cat f); f(){ local \"$c=1\"; }; f",
  // R6: flagged for bash >= 4.3 semantics
  "c=$(cat f); declare -n r=$c", "c=$(cat f); unset \"$c\"",
];
const UNTAINTED_NAMES = ["c=$(cat f); echo \"$c\"", "echo ${!prefix*}", "declare -n r=literal"];

describe("data-derived values used as variable names (R5)", () => {
  it.each(TAINTED_NAMES)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(UNTAINTED_NAMES)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});

// Fix round 1: data reaching an evaluation context through a direct
// substitution, an integer declaration, a default assignment, the positional
// parameters, a glob array, an attached option, or a bash 4+ name operand.
const ROUND1_MUTATING = [
  "echo $(( $(cat f) ))", "(( $(cat f) ))", "echo $[ $(cat f) ]", "arr[$(cat f)]=1", "echo ${arr[$(cat f)]}",
  "let \"$(cat f)\"", "[[ $(cat f) -eq 1 ]]", "echo $(( $(<f) ))",
  "echo $(( `cat f` ))", "(( `cat f` ))", "echo $[ `cat f` ]", "arr[`cat f`]=1", "echo ${arr[`cat f`]}",
  "let \"`cat f`\"", "[[ `cat f` -eq 1 ]]",
  "bash -c 'echo $(( $(cat f) ))'", "bash -c '(( $(cat f) ))'",
  "declare -i n=$(cat f)", "declare -i n; n=$(cat f)", "declare -i n; read n < f", "typeset -i n=$(cat f)",
  "g() { local -i n=$(cat f); }; g",
  ": ${c:=$(cat f)}; echo $((c))", ": ${c=$(cat f)}; ((c))", ": ${c:=$(cat f)}; echo ${!c}",
  "set -- \"$(cat f)\"; (( $1 ))", "set -- \"$(cat f)\"; c=$1; ((c))", "set -- \"$(cat f)\"; echo ${!1}",
  "set -- *; echo $(($1))", "g() { echo $(($1)); }; g \"$(cat f)\"", "sh -c 'echo $(($1))' _ \"$(cat f)\"",
  "x=(*); echo $((x))", "arr=(*); ((arr))", "for x in *; do ((x)); done",
  "c=$(cat f); printf -v\"$c\" x", "c=$(cat f); read -a\"$c\" <<< x",
  "c=$(cat f); mapfile -t \"$c\" < f", "c=$(cat f); readarray -t \"$c\" < f", "c=$(cat f); [[ -R $c ]]",
  "c=$(cat f); wait -p \"$c\"",
];
const ROUND1_READ_ONLY = [
  "x=5; echo $((x+1))", "echo $((3*4))", "echo $((RANDOM % 10))", "n=$(wc -l < f); echo \"$n\"", "echo ${#arr[@]}",
  "c=$(cat f); echo \"$c\"", "echo ${!prefix*}", "declare -n r=literal", "(( a <(echo 1) ))",
];

describe("taint fix round 1", () => {
  it.each(ROUND1_MUTATING)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(ROUND1_READ_ONLY)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});

// R12: a substitution's output used directly as a variable name.
const R12_MUTATING = [
  "printf -v \"$(cat f)\" x", "read \"$(cat f)\" <<< x", "read -a \"$(cat f)\" <<< x", "declare \"$(cat f)=1\"",
  "export \"$(cat f)=1\"", "readonly \"$(cat f)=1\"", "g() { local \"$(cat f)=1\"; }; g", "typeset \"$(cat f)=1\"",
  "unset \"$(cat f)\"", "getopts a \"$(cat f)\"", "mapfile -t \"$(cat f)\" < f", "declare -n r=\"$(cat f)\"",
  "[[ -v $(cat f) ]]", "printf -v \"`cat f`\" x", "printf -v \"$(<f)\" x",
];
const R12_READ_ONLY = ["printf -v out '%s' \"$(cat f)\"", "read -r line < f"];

describe("substitutions used directly as variable names (R12)", () => {
  it.each(R12_MUTATING)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(R12_READ_ONLY)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});

// Fix round 2: declare-family data operands, wait clusters, mapfile callbacks (R13).
const ROUND2_MUTATING = [
  "declare \"$(cat f)\"", "declare $(cat f)", "declare -- \"$(cat f)\"", "declare -a \"$(cat f)\"",
  "g() { local $(cat f); }; g", "bash -c 'declare \"$(cat f)\"'", "c=$(cat f); declare \"$c\"",
  "c=$(cat f); wait -np \"$c\"", "c=$(cat f); wait -fp \"$c\"", "wait -np \"$(cat f)\"",
  "c=$(cat f); mapfile -C \"$c\" -c 1 arr < f", "mapfile -C \"$(cat f)\" -c 1 arr < f",
  "c=$(cat f); readarray -C \"$c\" < f", "mapfile -C\"$(cat f)\" arr < f",
];
const ROUND2_READ_ONLY = ["declare -a arr", "local x=5", "declare -p literal", "mapfile -t arr < f"];

describe("taint fix round 2", () => {
  it.each(ROUND2_MUTATING)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(ROUND2_READ_ONLY)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});

// E-C: a here-string or heredoc feeding an interpreter that has no -c/-e
// program is that interpreter's program, and is classified like one.
const STDIN_PROGRAM_MUTATING = [
  // Brief rows.
  "python3 <<< 'import os;os.remove(\"x\")'", "node <<< 'require(\"fs\").rmSync(\"x\")'",
  "ruby <<< 'File.write(\"x\",\"y\")'", "python3 - <<'EOF'\nimport os; os.remove(\"x\")\nEOF",
  "tclsh <<< 'exec id'", "php <<< '<?php unlink(\"x\");'",
  // Spellings of the redirection and the head.
  "python3<<<'import os;os.remove(\"x\")'", "<<<'import os;os.remove(\"x\")' python3",
  "python3 0<<< 'import os;os.remove(\"x\")'", "python3.12 <<< 'import os;os.remove(\"x\")'",
  "nodejs <<< 'require(\"fs\").rmSync(\"x\")'", "env X=1 python3 <<< 'import os;os.remove(\"x\")'",
  "python3 <<< $'import os\\nos.remove(\"x\")'", "python3 <<< \"import os;os.remove('x')\"",
  "python3 <<EOF\nimport os; os.remove(\"x\")\nEOF", "python3 <<-EOF\n\timport os; os.remove(\"x\")\n\tEOF",
  "python3 <<\"EOF\"\nimport os; os.remove(\"x\")\nEOF", "python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['id'])\nEOF",
  "perl <<'EOF'\nunlink 'x';\nEOF", "ruby - <<'EOF'\nFile.write('x', 'y')\nEOF",
  "node <<'EOF'\nrequire('fs').rmSync('x')\nEOF", "python3 <<'EOF' <<< 'import os;os.remove(\"x\")'\nprint(1)\nEOF",
  // Allowlist, not blocklist: an unlisted call in a stdin program stops too.
  "python3 <<< '__import__(\"shutil\").rmtree(\"x\")'",
  // Programs the shell rewrites before the interpreter sees them.
  "python3 <<< \"$code\"", "python3 <<< $(cat f)", "python3 <<EOF\n$(cat f)\nEOF",
  "python3 <<EOF\nprint(\"$x\")\nEOF", "python3 <<'E'OF\nprint(1)\nE\nimport os;os.remove('x')\nEOF",
  // Unterminated heredoc: the program runs to end of input.
  "python3 <<'EOF'\nimport os; os.remove(\"x\")",
  // Structural positions.
  "(python3 <<'EOF'\nimport os; os.remove(\"x\")\nEOF\n)", "if true; then python3 <<'EOF'\nimport os; os.remove(\"x\")\nEOF\nfi",
  "x=$(python3 <<'EOF'\nimport os; os.remove(\"x\")\nEOF\n)", "case a in a) python3 <<'EOF'\nimport os; os.remove(\"x\")\nEOF\n;; esac",
  "f() { python3 <<'EOF'\nimport os; os.remove(\"x\")\nEOF\n}; f", "echo $(case a in a) python3 <<'EOF'\nimport os; os.remove(\"x\")\nEOF\n;; esac)",
  "ls; python3 <<< 'import os;os.remove(\"x\")'", "bash -c 'python3 <<< \"import os;os.remove(1)\"'",
  // Interpreters with no reader allowlist: any stdin program stops.
  "tclsh <<'EOF'\nputs hi\nEOF", "wish <<< 'puts hi'", "expect <<< 'spawn id'", "tclsh8.6 <<< 'puts hi'",
  // A here-string must not open a heredoc that hides the next line.
  "cat <<< 'E'\nrm -rf x\nE",
];
const STDIN_PROGRAM_READ_ONLY = [
  "python3 <<< 'print(1)'", "node <<< 'console.log(1)'", "perl <<< 'print 1'",
  "python3 - <<'EOF'\nprint(1)\nEOF", "python3 <<EOF\nprint(1)\nEOF", "(python3 <<'EOF'\nprint(1)\nEOF\n)",
  "python3 -c 'print(1)' <<< 'hello'", "cat <<'EOF'\nimport os; os.remove(\"x\")\nEOF",
  "grep x <<< 'os.remove(1)'", "cat <<< 'E'\nls\nE",
];

describe("here-string/heredoc interpreter programs (E-C)", () => {
  it.each(STDIN_PROGRAM_MUTATING)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(STDIN_PROGRAM_READ_ONLY)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});

// R14 (a): an interpreter with no inline program and no script reads its
// program from stdin; unless that stdin is a scanned here-string/heredoc, the
// program is unseen.
const UNSEEN_STDIN_MUTATING = [
  "echo x | python3", "cat f | node", "printf 'x' | ruby -", "echo x | perl", "echo x | php", "echo x | python3 -",
  "{ python3; } <<< 'print(1)'", "( node ) < f", "while read l; do python3; done < f", "python3 < x.py",
  "echo x | { python3; }", "echo x | env python3", "echo x | python3.12", "cat f | tclsh", "f() { python3; }; echo x | f",
  "python3 <<< 'print(1)' < f", "echo x | node --", "echo x | ruby -w",
];
const UNSEEN_STDIN_READ_ONLY = [
  "python3 --version | cat", "echo x | python3 -c 'import sys; print(sys.stdin.read())'", "node --version",
  "echo x | node -e 'console.log(1)'", "perl -v", "ruby --version", "command -v node", "ls # python3",
];

describe("interpreters reading an unseen program from stdin (R14a)", () => {
  it.each(UNSEEN_STDIN_MUTATING)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(UNSEEN_STDIN_READ_ONLY)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});

// R14 (b): an arithmetic `<<` is a shift, not a here-document, so the lines
// after it are commands.
const ARITHMETIC_SHIFTS = ["echo $((1<<2))", "(( y = 1<<2 ))", "let \"a<<=1\"", "echo $[1<<2]", "x=$((a<<b))", "for ((i=1<<2; i<9; i++)); do :; done"];
const ARITHMETIC_SHIFT_MUTATING = ARITHMETIC_SHIFTS.flatMap((c) => [`${c}\nrm -rf x\n2`, `${c}\nrm -rf x\nb`]);
// Real heredocs after an arithmetic shift still parse (their masking is
// asserted in lexer.test.ts; under R18 a writer-looking body stops anyway).
const HEREDOC_STILL_DATA = [
  "cat <<EOF\nhello\nEOF", "cat <<-EOF\n\thello\n\tEOF", "cat << 'EOF'\nhello\nEOF", "echo $((1<<2)); cat <<EOF\nhello\nEOF",
];

describe("arithmetic << is not a heredoc (R14b)", () => {
  it.each(ARITHMETIC_SHIFT_MUTATING)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each([...ARITHMETIC_SHIFTS, ...HEREDOC_STILL_DATA])("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});

// R14 (c): an inline program spelled with a shell expansion is unseen.
const DYNAMIC_INLINE_MUTATING = [
  "python3 -c \"$x\"", "node -e \"$(cat f)\"", "perl -e $p", "ruby -e \"${code}\"", "python3 -c \"`cat f`\"",
  "node --eval=\"$x\"", "perl -e\"$p\"", "php -r \"$x\"", "python3 -c$x",
];

describe("dynamic inline interpreter programs (R14c)", () => {
  it.each(DYNAMIC_INLINE_MUTATING)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(["python3 -c 'print(\"$x\")'", "perl -e 'print $x'"])("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});

// Review fix round 1 (R16, R17). R16: a backslash (or quote) inside an
// arithmetic context makes its extent unknowable, so the command stops rather
// than risk a fake heredoc hiding the next line.
const FIX1_MUTATING = [
  "false && echo $(( \\)\\) <<true ))\nrm -rf x\ntrue", "false && (( \\)\\) <<true ))\nrm -rf x\ntrue",
  "false && echo $[ \\] <<true ]\nrm -rf x\ntrue", "false && echo $(( \")\" <<true ))\nrm -rf x\ntrue",
  // A CR anywhere in a heredoc feeding an interpreter: bash's delimiter match is raw.
  "python3 <<pass\nprint(1)\npass\r\nimport os\nos.system('x')\npass",
  // R17: stdin readers unless the argv is solely info flags.
  "echo x | node --input-type module", "echo x | node --title x", "echo x | ruby -wv", "echo x | ruby -v -w",
  "echo x | ruby -v -", "cat f | deno repl", "cat f | deno -q", "cat f | bun repl", "echo x | tclsh -encoding utf-8",
  "echo x | python3 -u --version", "echo x | deno --log-level debug",
];
const FIX1_READ_ONLY = [
  "echo $((1<<2))", "echo x | ruby -v", "deno --version", "bun --version", "echo x | perl -v", "node --help",
  "cat <<EOF\r\nx\r\nEOF\r\n",
];

describe("review fix round 1 (R16, R17)", () => {
  it.each(FIX1_MUTATING)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(FIX1_READ_ONLY)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
  // A script operand means stdin is data, not the program; the script itself
  // is repository code, so D1 (not the stdin rule) stops it.
  it("echo x | node x.js: stdin is data, the script is D1", () => {
    expect(findDestructiveToken("echo x | node x.js")).toMatch(/^runs repository script node x\.js /);
  });
});

// R18: every known trick that made heredoc masking hide a command line. The
// classifier also runs a pass with no heredoc masking at all, so none of these
// (nor any future scanner miss) can hide `rm`.
const HIDDEN_LINE_TRICKS = [
  "false && echo \"$(( \" <<x \" ))\"\nrm -rf x\nx", "false && echo \"$(( ' \" <<x \" ' ))\"\nrm -rf x\nx",
  "false && echo \"$[ \" <<x \" ]\"\nrm -rf x\nx", "# <<x\nrm -rf y\nx", "ls # <<x\nrm -rf y\nx", "ls #<<x\nrm -rf y\nx",
  "echo $((1<<2))\nrm -rf x\n2", "(( y = 1<<2 ))\nrm -rf x\n2", "echo $[1<<2]\nrm -rf x\n2", "x=$((a<<b))\nrm -rf x\nb",
  "false && echo $(( \\)\\) <<true ))\nrm -rf x\ntrue", "false && (( \\)\\) <<true ))\nrm -rf x\ntrue",
  "false && echo $[ \\] <<true ]\nrm -rf x\ntrue", "cat <<< 'E'\nrm -rf x\nE", "cat <<pass\nx\npass\r\nrm -rf x\npass",
];
// Under R18 a heredoc body's text is also classified as commands: a body that
// reads like a writer stops (accepted cost); benign bodies stay read-only.
const HEREDOC_BODY_AS_TEXT = ["cat <<EOF\nrm -rf x\nEOF", "cat <<'EOF'\nvalue > other\nEOF"];
const HEREDOC_BENIGN = ["cat <<EOF\nhello world\nEOF", "cat <<-EOF\n\thello\n\tEOF", "cat << 'EOF'\nhello\nEOF", "python3 - <<'EOF'\nprint(1)\nEOF"];

describe("heredoc masking can never hide a line (R18)", () => {
  it.each([...HIDDEN_LINE_TRICKS, ...HEREDOC_BODY_AS_TEXT])("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(HEREDOC_BENIGN)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});

// Fix round 2: bun is allowlist-shaped like node.
describe("bun stdin programs (fix round 2)", () => {
  it.each(["echo x | bun run -", "echo x | bun run", "echo x | bun run --watch x.ts", "cat f | bun repl"])("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(["bun --version"])("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
  // A script operand: stdin is data; the script is repository code (D1).
  it.each(["echo x | bun x.ts", "echo x | bun run x.ts"])("D1, not a stdin program: %s", (c) =>
    expect(findDestructiveToken(c)).toMatch(/^runs repository script bun /));
});

// Fix round 3: a heredoc inside backticks has no body in the outer parse, and
// the unmasked pass judges stdin programs too.
describe("backtick heredocs and unmasked stdin programs (fix round 3)", () => {
  it.each([
    "echo `cat <<x`\npython3 <<< 'import os;os.remove(1)'\nx", "echo `cat <<x`\necho 'import os;os.remove(1)' | python3\nx",
    "echo `cat <<x`\nnode <<< 'require(\"fs\").rmSync(1)'\nx", "echo `cat <<x`\nrm -rf y\nx",
  ])("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(["echo `cat <<x`\nls\nx", "echo $(cat <<x\nhello\nx\n)"])("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});

// Task 5 (E-D): exec-capable editors/debuggers/tools and missed writers.
const EXEC_CAPABLE_MUTATING = [
  "osascript -e 'x'", "osascript f.scpt", "osascript",
  "vim -c '!id' f", "vim +'!id' f", "view -c '!id' f", "ex -c '!id' f", "nvim -c '!id' f",
  "emacs --batch --eval '(x)'", "emacs -batch -l f.el",
  "gdb -batch -ex 'shell id'", "gdb -x f",
  "expect -c 'spawn id'", "expect f.exp",
  "R -e 'x'", "R -f f.R", "R --file=f.R",
  "tclsh f.tcl", "wish f.tcl",
  "man -P 'sh -c id' ls", "man --pager='x' ls", "MANPAGER='sh -c id' man ls",
  "flock /tmp/l -c 'rm x'", "flock /tmp/l rm x",
  "tar --index-file=o -tf a.tar", "tar --volno-file=o -tf a", "tar --rsh-command=/bin/sh -tf h:a", "tar --rmt-command=x -tf h:a",
  "split -l 10 f out", "csplit f 5", "mkfifo p",
  // Siblings of the rows above: versioned/wrapped heads, exported pager, nested flock payloads.
  "tclsh8.6 f.tcl", "nice vim -c '!id' f", "vim f", "gdb", "export MANPAGER='sh -c id'", "man -HP x ls",
  "flock -w 5 /tmp/l python3 -c 'import os; os.remove(\"x\")'", "flock /tmp/l -c 'echo hi > x'", "flock /tmp/l -c",
  "tar --rsh=/bin/sh -tf h:a",
];
const EXEC_CAPABLE_READ_ONLY = [
  "vim --version", "man ls", "tar -tf a.tar", "flock /tmp/l cat f",
  "gdb --version", "emacs --version", "R --version", "man -k printf", "flock 3", "flock -s /tmp/l -c 'cat f'", "split --help",
];

describe("exec-capable tools and missed writers (E-D)", () => {
  it.each(EXEC_CAPABLE_MUTATING)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(EXEC_CAPABLE_READ_ONLY)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
});
