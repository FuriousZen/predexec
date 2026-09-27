/**
 * predexec policy — shell path operands for host read rules (MCP adapters).
 *
 * The one resolver every read-rule checker uses for shell commands:
 * policy-claude.ts (`Read(...)` rules) and policy-antigravity.ts
 * (`read_file(...)` grants). It names every path a command may read —
 * known readers' operands (host parity, CC-3), every other head's operands
 * (E-E), `<` redirect targets, git object names and pathspecs — expanding
 * braces and globs boundedly, and reports the first operand it cannot
 * resolve (R27/I2) so the caller stops instead of guessing.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  inlineProgramReadPaths,
  inspectCommandSubstitutionTree,
  lexShellWords,
  splitCommandSegments,
  stripLeadingAssignmentsAndWrappers,
  type WrapperInspectionOptions,
} from "../core/index.ts";

/** A shell word: its dequoted value and its source spelling. */
interface RawWord {
  value: string;
  raw: string;
  /** Taken from an option's `=value`. */
  inline?: boolean;
  /** git's `<rev>:<path>` object names and pathspecs resolve differently from shell paths. */
  git?: "rev" | "pathspec";
}

/** Shell file readers whose operands are read-rule targets (CC-3). */
const SHELL_READERS = new Set([
  "cat", "head", "tail", "less", "more", "sed", "awk", "grep", "rg", "wc", "sort", "uniq",
  "cut", "tr", "nl", "od", "xxd", "file", "stat",
  // Beyond the brief's list: other commands that print or digest a named
  // file. `tee` is deliberately absent — it reads stdin; its FILE args are
  // written, which is Edit's business (and a mutation stop here).
  "diff", "cmp", "base64", "strings", "hexdump", "bat", "jq", "yq",
  "paste", "comm", "join", "look", "pr", "iconv",
]);
/** Readers whose first operand is a script/pattern/filter unless one is given by option. */
const SCRIPT_FIRST = new Set(["sed", "awk", "grep", "rg", "jq", "yq", "look"]);
/** yq v4 subcommands that may precede the expression. */
const YQ_SUBCOMMANDS = new Set(["eval", "e", "eval-all", "ea"]);
/** Options taking TWO values; `file` says whether the second is a file the command reads. */
const PAIR_OPTIONS: Record<string, Record<string, { file: boolean }>> = {
  jq: {
    "--arg": { file: false },
    "--argjson": { file: false },
    "--slurpfile": { file: true },
    "--rawfile": { file: true },
  },
};
/** Options whose value is the script/pattern (so no positional script follows). */
const SCRIPT_OPTIONS: Record<string, ReadonlySet<string>> = {
  grep: new Set(["-e", "--regexp"]),
  rg: new Set(["-e", "--regexp"]),
  sed: new Set(["-e", "--expression"]),
};
/** Options whose value is a file the command reads (and which replaces the positional script). */
const FILE_OPTIONS: Record<string, ReadonlySet<string>> = {
  grep: new Set(["-f", "--file"]),
  rg: new Set(["-f", "--file"]),
  sed: new Set(["-f", "--file"]),
  awk: new Set(["-f", "--file"]),
  jq: new Set(["-f", "--from-file"]),
  hexdump: new Set(["-f"]),
  // macOS `base64 -i FILE` reads FILE (GNU's `-i` is a flag; taking the next
  // word as a file there only adds a check).
  base64: new Set(["-i", "--input"]),
};
/** Options that take a separate non-file value, skipped so it is not taken for an operand. */
const VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  grep: new Set(["-m", "-A", "-B", "-C", "--max-count", "--after-context", "--before-context", "--context"]),
  rg: new Set(["-m", "-A", "-B", "-C", "-g", "-t", "-T", "-M", "-j", "--glob", "--type", "--type-not", "--max-count"]),
  awk: new Set(["-F", "-v"]),
  cut: new Set(["-d", "-f", "-c", "-b"]),
  sort: new Set(["-t", "-k"]),
  head: new Set(["-n", "-c"]),
  tail: new Set(["-n", "-c"]),
  od: new Set(["-A", "-t", "-j", "-N"]),
  xxd: new Set(["-l", "-s", "-c", "-g"]),
  diff: new Set(["-U", "-C", "-L", "--label", "-I", "--ignore-matching-lines", "-x", "--exclude"]),
  cmp: new Set(["-i", "-n", "--ignore-initial", "--bytes"]),
  hexdump: new Set(["-n", "-s", "-e"]),
  strings: new Set(["-n", "-t", "--bytes", "--radix"]),
  base64: new Set(["-w", "-b", "--wrap", "--break", "-o", "--output"]),
  bat: new Set(["-l", "-r", "-H", "-m", "--language", "--line-range", "--highlight-line", "--map-syntax", "--theme", "--style"]),
  jq: new Set(["--indent", "--tab-width"]),
  yq: new Set(["-p", "-o", "-I", "--input-format", "--output-format", "--indent"]),
  paste: new Set(["-d", "--delimiters"]),
  join: new Set(["-t", "-1", "-2", "-j", "-o", "-e", "-a", "-v"]),
  comm: new Set(["--output-delimiter"]),
  look: new Set(["-t"]),
  pr: new Set(["-h", "--header", "-o", "-w", "-W", "-l", "-N"]),
  iconv: new Set(["-f", "-t", "-o", "--from-code", "--to-code", "--output"]),
};

/** Redirect operators, tested against a token's SOURCE spelling: a quoted `'<'` is a word. */
const INPUT_REDIRECT_RE = /^\d*<>?(?![<&(])/;
const DUP_INPUT_REDIRECT_RE = /^\d*<&$/;
const SKIP_NEXT_REDIRECT_RE = /^(?:\d*<<<?-?|\d*>>?|&>>?|\d*>\||\d*>&)$/;
const OUTPUT_REDIRECT_RE = /^(?:\d*|&)>/;
const REDIRECT_OPERATOR_RE = /^(?:<<<|<<-|<<|<>|<&|<|>>|>&|>\||>)/;

/**
 * Space out every unquoted redirect operator so it is its own word: bash
 * splits `cat<.env`, `cat -n<.env` and `x 2>/dev/null<.env` at the operator,
 * but the word lexer keeps them whole. A leading all-digit run (`2>`, `0<`)
 * or `&` (`&>`) stays with its operator, as in bash. Text inside `$(…)`,
 * `${…}`, backticks and process substitutions is left alone — those bodies
 * are inspected as commands of their own.
 */
function spaceRedirects(segment: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let backtick = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      out += ch + (segment[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "`") backtick = !backtick;
    else if (ch === "$" && (segment[i + 1] === "(" || segment[i + 1] === "{")) {
      depth++;
      out += ch + segment[i + 1];
      i++;
      continue;
    } else if (depth > 0 && (ch === "(" || ch === "{")) depth++;
    else if (depth > 0 && (ch === ")" || ch === "}")) depth--;
    if (quote === '"') {
      out += ch;
      if (ch === '"' && depth === 0 && !backtick) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if ((ch !== "<" && ch !== ">") || depth > 0 || backtick) {
      out += ch;
      continue;
    }
    if (segment[i + 1] === "(") {
      depth++; // `<(…)` / `>(…)`: a process substitution, not a redirect
      out += ch + "(";
      i++;
      continue;
    }
    const op = REDIRECT_OPERATOR_RE.exec(segment.slice(i))![0];
    const fd = /(?:^|\s)(\d+|&)$/.exec(out);
    const prefix = fd ? fd[1]! : "";
    out = `${out.slice(0, out.length - prefix.length)} ${prefix}${op} `;
    i += op.length - 1;
  }
  return out;
}

/**
 * File operands named by a shell command: known readers' operands, every
 * other head's non-option words and `--opt=value` values (E-E: `column .env`
 * reads the file whether or not the host recognizes `column`), and every
 * `<` redirect target ("Read and Edit deny rules apply ... to file commands
 * Claude Code recognizes in Bash, such as `cat`, `head`, `tail`, `sed` ... and
 * to the targets of Bash redirections such as ... `< file`").
 *
 * Every clause is inspected — substitution bodies and control-structure
 * bodies included — via core's shared shell inspection. `cd` anywhere makes
 * relative operands unresolvable (the host prompts on "a relative path that
 * follows a `cd` in the same command").
 */
interface ShellOperands {
  /** Known readers' file operands and `<` targets: the host's own recognized reads. */
  operands: RawWord[];
  /** Every other head's non-option words and `--opt=value` values (E-E). */
  generic: RawWord[];
  /**
   * Values attached to a short option (`-i.env`, `-f.env`) on any head (R27(a)):
   * checked as the named path only — never as a searched directory, since
   * `cut -d.` names no directory to walk.
   */
  direct: RawWord[];
  /** `cd`/`pushd` targets in source order; null for a bare `cd` (home). */
  cdTargets: (RawWord | null)[];
  afterCd: boolean;
  complete: boolean;
}

/**
 * Heads whose words are never read as file content (R24): directory changes,
 * output-only builtins, and `test`/`[`/`[[` — whose file operators (`-f`,
 * `-r`, …) inspect metadata only, never content, so the whole family is
 * exempt. `<` redirects and substitutions inside these commands are still
 * inspected: they are separate reads.
 */
const NON_READING_HEADS = new Set(["cd", "pushd", "popd", "echo", "printf", "printenv", "true", "false", ":", "test", "[", "[["]);

/** git global options whose value is a directory later paths resolve against. */
const GIT_DIR_OPTIONS = new Set(["-C", "--work-tree"]);

function shellReadOperands(command: string, wrapperOptions?: WrapperInspectionOptions): ShellOperands {
  const inspected = inspectCommandSubstitutionTree(command);
  const operands: RawWord[] = [];
  const generic: RawWord[] = [];
  const cdTargets: (RawWord | null)[] = [];
  const direct: RawWord[] = [];
  let afterCd = false;
  for (const text of inspected.commands) {
    for (const line of text.split("\n")) {
      for (const segment of splitCommandSegments(line)) {
        // Keep each word's source spelling: brace expansion must know which
        // braces were quoted or escaped (literal) — the value has lost that.
        const spaced = spaceRedirects(segment);
        const tokens: RawWord[] = lexShellWords(spaced).words.map((w) => ({ value: w.value, raw: spaced.slice(w.start, w.end) }));
        const words: RawWord[] = [];
        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i]!;
          const input = INPUT_REDIRECT_RE.exec(token.raw);
          if (input) {
            // `<`, `N<`, `<>`: the next word (or an attached rest) is read.
            const rest = token.raw.slice(input[0].length);
            const target = rest ? { value: lexShellWords(rest).words.map((w) => w.value).join(""), raw: rest } : tokens[++i];
            if (target !== undefined) operands.push(target);
          } else if (DUP_INPUT_REDIRECT_RE.test(token.raw)) {
            // `<&N` duplicates a descriptor; `<&word` with a non-number names a file.
            const target = tokens[++i];
            if (target !== undefined && !/^(?:\d+-?|-)$/.test(target.value)) operands.push(target);
          } else if (SKIP_NEXT_REDIRECT_RE.test(token.raw)) {
            i++; // heredoc delimiter, here-string word, or output target
          } else if (!OUTPUT_REDIRECT_RE.test(token.raw) && !/^\d*<[<&(]/.test(token.raw)) {
            words.push(token);
          }
        }
        const values = words.map((w) => w.value);
        const stripped = stripLeadingAssignmentsAndWrappers(values, wrapperOptions);
        // Stripping removes a prefix; map back to the raw words by offset.
        const offset = values.length - stripped.length;
        const argv: RawWord[] = stripped.every((v, i) => v === values[offset + i])
          ? words.slice(offset)
          : stripped.map((value) => ({ value, raw: "\\" })); // unmappable: mark as quoted (fail closed on braces)
        const head = argv[0] === undefined ? "" : basename(argv[0].value);
        if (head === "cd" || head === "pushd") {
          afterCd = true;
          const target = genericOperands(argv.slice(1))[0];
          if (target?.value !== "-") cdTargets.push(target ?? null); // `cd -` returns to a dir already in play
        }
        const args = argv.slice(1);
        if (!NON_READING_HEADS.has(head)) direct.push(...attachedOptionValues(args));
        if (SHELL_READERS.has(head)) {
          const read = readerOperands(head, args);
          operands.push(...read);
          // Values of `--opt=value` the reader tables do not know (`diff --from-file=.env`).
          generic.push(...genericOperands(args).filter((word) => word.inline));
          if (read.length === 0 && searchesCwdImplicitly(head, args)) generic.push({ value: ".", raw: "." });
        } else if (!NON_READING_HEADS.has(head)) {
          // Any other head may read a path it is handed (`column .env`,
          // `git diff --no-index .env x`); perl's loop operands stay reader
          // operands too, so the old verdict is kept as a subset.
          if (head === "perl") operands.push(...perlLoopOperands(argv.slice(1)));
          if (head === "git") {
            generic.push(...gitOperands(argv.slice(1), cdTargets));
          } else {
            const words = genericOperands(args);
            generic.push(...words);
            if (words.filter((word) => !word.inline).length <= 1 && searchesCwdImplicitly(head, args)) generic.push({ value: ".", raw: "." });
          }
        }
      }
    }
  }
  return { operands, generic, direct, cdTargets, afterCd, complete: inspected.complete };
}

/**
 * git's operands: `-C DIR` / `--work-tree[=]DIR` become directory bases (like
 * `cd`); every other operand is a `<rev>:<path>` object name when it holds a
 * `:` (`HEAD:.env`, `:.env`, `:0:.env`, `:(top).env`), else a pathspec.
 */
function gitOperands(args: readonly RawWord[], cdTargets: (RawWord | null)[]): RawWord[] {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!.value;
    if (GIT_DIR_OPTIONS.has(arg) && args[i + 1] !== undefined) cdTargets.push(args[i + 1]!);
    else if (arg.startsWith("--work-tree=")) {
      const eq = args[i]!.raw.indexOf("=");
      cdTargets.push({ value: arg.slice("--work-tree=".length), raw: eq === -1 ? "\\" : args[i]!.raw.slice(eq + 1) });
    }
  }
  return genericOperands(args).map((word) => ({ ...word, git: word.value.includes(":") ? "rev" : "pathspec" }));
}

/** Non-option words, every word after `--`, and the value of each `--opt=value`. */
function genericOperands(args: readonly RawWord[]): RawWord[] {
  const out: RawWord[] = [];
  let endOfOptions = false;
  for (const word of args) {
    const arg = word.value;
    if (!endOfOptions && arg === "--") endOfOptions = true;
    else if (endOfOptions || !arg.startsWith("-") || arg === "-") out.push(word);
    else if (arg.startsWith("--") && arg.includes("=")) {
      const eq = word.raw.indexOf("=");
      // The raw spelling after `=` keeps its quoting when it maps cleanly.
      out.push({ value: arg.slice(arg.indexOf("=") + 1), raw: eq === -1 ? "\\" : word.raw.slice(eq + 1), inline: true });
    }
  }
  return out;
}

/** The value part of each attached short option (`-i.env` → `.env`), before `--`. */
function attachedOptionValues(args: readonly RawWord[]): RawWord[] {
  const out: RawWord[] = [];
  for (const word of args) {
    const arg = word.value;
    if (arg === "--") break;
    if (!/^-[^-]./s.test(arg)) continue;
    const flag = arg.slice(0, 2);
    out.push({ value: arg.slice(2), raw: word.raw.startsWith(flag) ? word.raw.slice(2) : "\\" });
  }
  return out;
}

/** Heads that search the cwd recursively when no path is given. */
const RECURSIVE_SEARCH_HEADS = new Set(["rg", "ag", "ack", "ack-grep", "rgrep"]);
const GREP_HEADS = new Set(["grep", "egrep", "fgrep"]);

/** True for a recursive search head (`rg`, `grep -r`, …): given no path, it reads the whole cwd. */
function searchesCwdImplicitly(head: string, args: readonly RawWord[]): boolean {
  if (RECURSIVE_SEARCH_HEADS.has(head)) return true;
  if (!GREP_HEADS.has(head)) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!.value;
    if (arg === "--") break;
    if (arg === "--recursive" || arg === "--dereference-recursive" || arg === "--directories=recurse") return true;
    if ((arg === "-d" || arg === "--directories") && args[i + 1]?.value === "recurse") return true;
    if (/^-[A-Za-z]*[rR]/.test(arg)) return true;
  }
  return false;
}

function readerOperands(head: string, args: readonly RawWord[]): RawWord[] {
  const out: RawWord[] = [];
  // Files named by option (`jq --rawfile NAME FILE`, `grep -f FILE`) are kept
  // apart from positionals so the script/filter shift below never drops one.
  const optionFiles: RawWord[] = [];
  let scriptGiven = false;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    const arg = word.value;
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
    } else if (!endOfOptions && arg.startsWith("-") && arg !== "-") {
      const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
      const pair = PAIR_OPTIONS[head]?.[name];
      if (pair) {
        const value = args[i + 2];
        i += 2;
        if (pair.file && value !== undefined) optionFiles.push(value);
      } else if (SCRIPT_OPTIONS[head]?.has(name)) {
        scriptGiven = true;
        if (inline === undefined) i++;
      } else if (FILE_OPTIONS[head]?.has(name)) {
        scriptGiven = true;
        const value = inline !== undefined ? { value: inline, raw: word.raw } : args[++i];
        if (value !== undefined) optionFiles.push(value);
      } else if (VALUE_OPTIONS[head]?.has(name) && inline === undefined) {
        i++;
      } else if (!arg.startsWith("--") && arg.length > 2 && FILE_OPTIONS[head]?.has(arg.slice(0, 2))) {
        // Attached file value on any reader: `base64 -i.env`, `grep -f.env`.
        scriptGiven = true;
        optionFiles.push({ value: arg.slice(2), raw: word.raw.startsWith(arg.slice(0, 2)) ? word.raw.slice(2) : "\\" });
      } else if (SCRIPT_FIRST.has(head) && /^-[ef]./.test(arg) && !arg.startsWith("--")) {
        // Attached short forms: `-eexpr`, `-f.env`.
        scriptGiven = true;
        if (arg[1] === "f") optionFiles.push({ value: arg.slice(2), raw: word.raw });
      }
    } else {
      out.push(word);
    }
  }
  if (head === "yq" && YQ_SUBCOMMANDS.has(out[0]?.value ?? "")) out.shift();
  if (SCRIPT_FIRST.has(head) && !scriptGiven) out.shift();
  return [...optionFiles, ...out];
}

/** perl switches whose value is the rest of the cluster (`-Mmod`, `-Idir`, `-i.bak`, `-F:`). */
const PERL_ATTACHED_VALUE = new Set(["M", "m", "I", "i", "x", "d", "D", "C", "F"]);

/**
 * File operands of `perl -n`/`-p` (and `-a`/`-F`, which imply `-n`): the
 * implicit `while (<>)` loop reads every operand. Without `-e`/`-E` the first
 * operand is the program file, which perl also reads. Other perl invocations
 * are not treated as readers.
 */
function perlLoopOperands(args: readonly RawWord[]): RawWord[] {
  let loop = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!.value;
    if (arg === "--") { i++; break; }
    if (!arg.startsWith("-") || arg === "-") break;
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j]!;
      if (letter === "n" || letter === "p" || letter === "a") loop = true;
      if (letter === "e" || letter === "E") {
        if (j === arg.length - 1) i++; // the program is the next word
        break;
      }
      if (letter === "F") loop = true;
      if (PERL_ATTACHED_VALUE.has(letter)) break;
      // `-l[octal]` and `-0[octal|xHEX]` take only digits; switches may follow (`-lane`).
      if (letter === "l" || letter === "0") {
        const digits = /^(?:x[0-9A-Fa-f]*|[0-7]*)/.exec(arg.slice(j + 1))![0];
        j += letter === "l" && digits.startsWith("x") ? 0 : digits.length;
      }
    }
  }
  return loop ? args.slice(i) : [];
}

/** Most words one operand's brace expansion may produce before it counts as unresolvable. */
const MAX_BRACE_WORDS = 64;
/** Most brace groups expanded (nested or in sequence) within one operand. */
const MAX_BRACE_DEPTH = 4;

/**
 * Bash brace expansion — `{a,b}` lists and `{1..3}` / `{a..c}` sequences — so
 * `cat {.env,x}` cannot slip a denied name past the check. Bounded: null when
 * the expansion exceeds MAX_BRACE_WORDS words or MAX_BRACE_DEPTH groups, and
 * the caller treats the operand as unresolvable. A brace group that is not an
 * expansion (`{}`, `{x}`) is literal, as in bash. Quoting is already stripped
 * by the tokenizer, so a quoted brace is expanded too — that only adds checks.
 */
function expandBraces(word: string, depth = 0): string[] | null {
  for (let open = word.indexOf("{"); open !== -1; open = word.indexOf("{", open + 1)) {
    let nesting = 0;
    let close = -1;
    const commas: number[] = [];
    for (let i = open; i < word.length; i++) {
      const ch = word[i];
      if (ch === "{") nesting++;
      else if (ch === "}" && --nesting === 0) {
        close = i;
        break;
      } else if (ch === "," && nesting === 1) commas.push(i);
    }
    if (close === -1) continue; // an unclosed `{` is literal; later groups still expand (bash)
    const inner = word.slice(open + 1, close);
    let alternatives: string[] | null = null;
    if (commas.length > 0) {
      // Commas inside a nested group belong to it; only depth-1 commas split.
      alternatives = [];
      let start = open + 1;
      for (const comma of [...commas, close]) {
        alternatives.push(word.slice(start, comma));
        start = comma + 1;
      }
    } else {
      const seq = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(inner);
      if (seq) alternatives = braceSequence(seq[1]!, seq[2]!, seq[3]);
      else continue; // literal braces; look for a later group
      if (alternatives === null) return null;
    }
    if (depth >= MAX_BRACE_DEPTH) return null;
    const prefix = word.slice(0, open);
    const suffix = word.slice(close + 1);
    const out: string[] = [];
    for (const alternative of alternatives) {
      const expanded = expandBraces(prefix + alternative + suffix, depth + 1);
      if (expanded === null) return null;
      out.push(...expanded);
      if (out.length > MAX_BRACE_WORDS) return null;
    }
    return out;
  }
  return [word];
}

/**
 * `{a..b[..step]}`. Numeric endpoints written with a leading zero pad every
 * term to the wider endpoint's width, as bash 4+ does (`{01..02}` →
 * `01 02`); a shell that does not pad (bash 3.2) only makes the padded
 * spelling an extra check.
 */
function braceSequence(from: string, to: string, stepText: string | undefined): string[] | null {
  const numeric = /^-?\d+$/.test(from) && /^-?\d+$/.test(to);
  if (!numeric && (/\d/.test(from) || /\d/.test(to))) return null;
  const a = numeric ? Number(from) : from.charCodeAt(0);
  const b = numeric ? Number(to) : to.charCodeAt(0);
  const step = Math.abs(Number(stepText ?? 1)) || 1;
  if (Math.abs(b - a) / step + 1 > MAX_BRACE_WORDS) return null;
  const padded = numeric && [from, to].some((end) => /^-?0\d/.test(end));
  const width = Math.max(from.length, to.length);
  const format = (v: number): string => {
    if (!numeric) return String.fromCharCode(v);
    if (!padded) return String(v);
    const digits = String(Math.abs(v)).padStart(width - (v < 0 ? 1 : 0), "0");
    return v < 0 ? `-${digits}` : digits;
  };
  const out: string[] = [];
  for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) out.push(format(v));
  return out;
}

/**
 * Resolve one shell operand to absolute paths, or a reason it cannot be
 * resolved. Brace expansion runs only when the word's source spelling has no
 * quoting or escaping: a quoted/escaped brace is literal in bash, and once the
 * tokenizer has removed the quotes the two are indistinguishable — so a word
 * with braces AND quoting is unresolvable (fail closed) rather than guessed.
 */
function resolveShellOperand(word: RawWord, cwd: string, home: string, afterCd: boolean, root: string): string[] | { unresolved: string } {
  const operand = word.value;
  if (operand === "-" || operand === "") return [];
  if (/[$`]/.test(operand)) return { unresolved: operand };
  if (/[{}]/.test(operand)) {
    if (/['"\\]/.test(word.raw)) return { unresolved: word.raw };
    const words = expandBraces(operand);
    if (words === null) return { unresolved: operand };
    if (words.length > 1 || words[0] !== operand) {
      const out: string[] = [];
      for (const expanded of words) {
        const resolved = resolveShellOperand({ value: expanded, raw: expanded }, cwd, home, afterCd, root);
        if (!Array.isArray(resolved)) return { unresolved: operand };
        out.push(...resolved);
      }
      return out;
    }
  }
  let path = operand;
  if (path === "~" || path.startsWith("~/")) path = join(home, path.slice(1));
  else if (path.startsWith("~")) return { unresolved: operand };
  if (afterCd && !isAbsolute(path)) return { unresolved: operand };
  if (/[*?[]/.test(path)) {
    // Expand the glob ourselves so `cat .en*` cannot slip past `Read(./.env)`.
    // `**` is recursive (zsh) and unbounded — refuse rather than walk it.
    if (path.includes("**")) return { unresolved: operand };
    const matches = expandGlobUnder(resolve(cwd, path), root);
    if (matches === null) return { unresolved: operand };
    return [resolve(cwd, path), ...matches];
  }
  return [resolve(cwd, path)];
}

/** Most paths one glob operand may match before it counts as unresolvable. */
const MAX_GLOB_MATCHES = 1000;
/** Most directory entries one glob operand may examine before it counts as unresolvable. */
const MAX_GLOB_ENTRIES = 10_000;

const isInsideDir = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Expand an absolute glob path the way the shell would, so `cat .en?`,
 * `column [.]env` and `echo *` are checked against every name they can
 * reach. Bounded and confined: null (unresolvable) when the pattern leaves
 * `root`, or examines more than MAX_GLOB_ENTRIES entries, or matches more
 * than MAX_GLOB_MATCHES paths. `*` also matches a leading dot — more
 * matches than bash only adds checks.
 */
function expandGlobUnder(pattern: string, root: string): string[] | null {
  if (!isInsideDir(root, pattern)) return null;
  const rel = relative(root, pattern);
  let current = [root];
  let budget = MAX_GLOB_ENTRIES;
  for (const segment of rel === "" ? [] : rel.split(sep)) {
    if (!/[*?[]/.test(segment)) {
      current = current.map((dir) => join(dir, segment));
      continue;
    }
    const tokens = compileGlobSegment(segment);
    if (tokens === null) return null;
    const next: string[] = [];
    for (const dir of current) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue; // not a directory (or unreadable): the shell matches nothing there either
      }
      budget -= names.length;
      if (budget < 0) return null;
      for (const name of names) if (globSegmentMatches(tokens, name)) next.push(join(dir, name));
      if (next.length > MAX_GLOB_MATCHES) return null;
    }
    current = next;
  }
  return current;
}

/** POSIX character classes a bracket expression may name (`[[:alpha:]]`). */
const POSIX_CLASSES: Record<string, RegExp> = {
  alpha: /[A-Za-z]/, digit: /[0-9]/, alnum: /[A-Za-z0-9]/, upper: /[A-Z]/, lower: /[a-z]/, space: /\s/,
  blank: /[ \t]/, punct: /[!-\/:-@[-`{-~]/, xdigit: /[0-9A-Fa-f]/, word: /\w/, cntrl: /[\x00-\x1f\x7f]/,
  print: /[\x20-\x7e]/, graph: /[\x21-\x7e]/,
};

type GlobToken = { star: true } | { test: (c: string) => boolean };

/**
 * Compile one glob segment: `*`, `?`, and bracket expressions with `!`/`^`
 * negation, a leading literal `]`, ranges, POSIX classes (`[:alpha:]`),
 * equivalence classes (`[=e=]`) and collating symbols (`[.e.]`). An unclosed
 * `[` is a literal, as in bash. Null — the caller treats the operand as
 * unresolvable — for a bracket expression this parser cannot read (an
 * unterminated `[:…:]`, an unknown class, a multi-character collating symbol).
 */
function compileGlobSegment(pattern: string): GlobToken[] | null {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") tokens.push({ star: true });
    else if (ch === "?") tokens.push({ test: () => true });
    else if (ch === "[") {
      let j = i + 1;
      const negate = pattern[j] === "!" || pattern[j] === "^";
      if (negate) j++;
      const items: ((c: string) => boolean)[] = [];
      let first = true;
      let closed = false;
      while (j < pattern.length) {
        const c = pattern[j]!;
        if (c === "]" && !first) {
          closed = true;
          break;
        }
        first = false;
        if (c === "[" && (pattern[j + 1] === ":" || pattern[j + 1] === "=" || pattern[j + 1] === ".")) {
          const kind = pattern[j + 1]!;
          const close = pattern.indexOf(`${kind}]`, j + 2);
          if (close === -1) return null;
          const name = pattern.slice(j + 2, close);
          if (kind === ":") {
            const re = POSIX_CLASSES[name];
            if (!re) return null;
            items.push((x) => re.test(x));
          } else {
            if ([...name].length !== 1) return null;
            items.push((x) => x === name);
          }
          j = close + 2;
          continue;
        }
        if (pattern[j + 1] === "-" && j + 2 < pattern.length && pattern[j + 2] !== "]") {
          const lo = c;
          const hi = pattern[j + 2]!;
          items.push((x) => x >= lo && x <= hi);
          j += 3;
          continue;
        }
        items.push((x) => x === c);
        j++;
      }
      if (!closed) {
        tokens.push({ test: (x) => x === "[" }); // unclosed: a literal `[`
        continue;
      }
      i = j;
      tokens.push({ test: negate ? (x) => !items.some((f) => f(x)) : (x) => items.some((f) => f(x)) });
    } else tokens.push({ test: (x) => x === ch });
  }
  return tokens;
}

/**
 * One path segment against compiled glob tokens. `*` also matches a leading
 * dot (more matches than bash only adds checks). Linear-backtracking
 * two-pointer match, so a model-authored `*a*a*a*b` cannot blow up.
 */
function globSegmentMatches(tokens: readonly GlobToken[], name: string): boolean {
  let t = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    const token = tokens[t];
    if (token && "star" in token) {
      star = t++;
      resume = n;
    } else if (token && token.test(name[n]!)) {
      t++;
      n++;
    } else if (star !== -1) {
      t = star + 1;
      n = ++resume;
    } else return false;
  }
  while (t < tokens.length && "star" in tokens[t]!) t++;
  return t === tokens.length;
}

/**
 * True when the shell passes this word through unchanged: no `$`/backtick
 * outside single quotes, and no unquoted glob, brace or leading tilde. Such a
 * word's dequoted value IS the argument, so it is checked as a literal path —
 * `node -e 'console.log($x)'` names no expansion. Anything else (or unbalanced
 * quoting) goes to the conservative resolver.
 */
function isLiteralWord(raw: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\\" && quote !== "'" && i + 1 >= raw.length) return false; // dangling escape (also the unmappable-word marker)
    if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (quote === '"') {
      if (ch === "\\") i++;
      else if (ch === '"') quote = null;
      else if (ch === "$" || ch === "`") return false;
    } else if (ch === "\\") i++;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "$" || ch === "`" || /[*?[{}]/.test(ch) || (i === 0 && ch === "~")) return false;
  }
  return quote === null;
}

/** Most directories `cd` targets may put a later relative operand in before it counts as unresolvable. */
const MAX_CD_BASES = 32;

/**
 * Every directory a relative operand might be relative to: the node's cwd
 * plus each literal `cd` target applied to every base so far (`cd a && cd b`
 * reaches a/b; clause order is not tracked, so every combination is tried).
 * Null when a target cannot be resolved (`cd $D`) or CDPATH could redirect it.
 */
function cdBases(targets: readonly (RawWord | null)[], cwd: string, home: string): string[] | null {
  let bases = [cwd];
  if (targets.length === 0) return bases;
  if (process.env.CDPATH) return null;
  for (const target of targets) {
    let next: string[];
    if (target === null) next = [home];
    else if (/^~(?:\/|$)/.test(target.raw)) next = [join(home, target.value.slice(1))];
    else if (isLiteralWord(target.raw)) next = bases.map((base) => resolve(base, target.value));
    else return null;
    bases = [...new Set([...bases, ...next])];
    if (bases.length > MAX_CD_BASES) return null;
  }
  return bases;
}

/** Longest word treated as a possible path: a longer argument cannot be opened (ENAMETOOLONG). */
const MAX_OPERAND_PATH_LENGTH = 4096;

/**
 * Absolute paths every file operand of `command` may name, relative to `cwd`,
 * or the first operand that cannot be resolved (R27/I2), or `incomplete`
 * when the command could not be fully inspected. Known readers' operands keep
 * their host-parity handling (any `cd` makes a relative one unresolvable);
 * every other head's operands (E-E) are resolved against each `cd` base.
 * Globs expand only under `root` (see expandGlobUnder).
 */
export function resolveShellPathOperands(
  command: string,
  opts: { cwd: string; root: string; home: string; wrapperOptions?: WrapperInspectionOptions },
): ShellPathOperands {
  const { cwd, root, home } = opts;
  const parsed = shellReadOperands(command, opts.wrapperOptions);
  const paths: string[] = [];
  const directPaths: string[] = [];
  const done = (unresolved: string | null): ShellPathOperands => ({ paths, directPaths, unresolved, complete: parsed.complete });
  for (const operand of parsed.operands) {
    const resolved = resolveShellOperand(operand, cwd, home, parsed.afterCd, root);
    if (!Array.isArray(resolved)) return done(resolved.unresolved);
    paths.push(...resolved);
  }
  const bases = cdBases(parsed.cdTargets, cwd, home);
  for (const [words, out] of [[parsed.generic, paths], [parsed.direct, directPaths]] as const) {
    for (const word of words) {
      const why = resolveGenericWord(word, bases, { cwd, root, home }, out);
      if (why !== null) return done(why);
    }
  }
  // Paths inline interpreter programs open (`python3 -c "open('.env')"`), R27(c).
  const inline = inlineProgramReadPaths(command);
  if (inline.unresolved !== null) return done(`inline program read: ${inline.unresolved}`);
  for (const path of inline.paths) {
    if (path === "" || path.length > MAX_OPERAND_PATH_LENGTH) continue;
    if (isAbsolute(path)) paths.push(resolve(path));
    else if (bases === null) return done(path);
    else paths.push(...bases.map((base) => resolve(base, path)));
  }
  return done(null);
}

export interface ShellPathOperands {
  /** Paths read, directories included as searched (their contents are read). */
  paths: string[];
  /** Paths named by an attached short-option value: checked as named, never as a searched directory. */
  directPaths: string[];
  /** The first operand that cannot be resolved (R27/I2), or null. */
  unresolved: string | null;
  /** False when the command could not be fully inspected. */
  complete: boolean;
}

/** Resolve one generic (any-head) operand into `out`; the unresolvable spelling, or null. */
function resolveGenericWord(
  word: RawWord,
  bases: readonly string[] | null,
  env: { cwd: string; root: string; home: string },
  out: string[],
): string | null {
  const { cwd, root, home } = env;
  if (word.value === "" || word.value === "-" || word.value.length > MAX_OPERAND_PATH_LENGTH) return null;
  if (word.git === "rev") {
    if (bases === null || !isLiteralWord(word.raw)) return word.value;
    const gitPaths = gitRevPaths(word.value, bases, root);
    if (gitPaths === null) return word.value;
    out.push(...gitPaths);
    return null;
  }
  // git expands pathspec wildcards itself, quoted or not (`-- '*.env'`).
  if (word.git === "pathspec" && /[*?[]/.test(word.value)) return word.value;
  if (isLiteralWord(word.raw) && !word.value.startsWith("~")) {
    if (isAbsolute(word.value)) out.push(resolve(word.value));
    else if (bases === null) return word.value;
    else out.push(...bases.map((base) => resolve(base, word.value)));
    return null;
  }
  for (const base of bases ?? [cwd]) {
    const resolved = resolveShellOperand(word, base, home, bases === null, root);
    if (!Array.isArray(resolved)) return resolved.unresolved;
    out.push(...resolved);
  }
  // A quoted `~` is literal; check that spelling as well as home's.
  if (word.value.startsWith("~") && !isAbsolute(word.value)) out.push(...(bases ?? [cwd]).map((base) => resolve(base, word.value)));
  return null;
}

/**
 * Paths a git `<rev>:<path>` object name (or `:`-prefixed pathspec) reads:
 * `rev:path` / `:path` / `:N:path` resolve against the repository root, except
 * `rev:./path` and `rev:../path`, which resolve against the cwd ("a path
 * starting with ./ or ../ is relative to the current working directory");
 * `:/path` and `:(magic)path` resolve against the root too. Every cd base's
 * repository is tried. Null (unresolvable) when the path part holds a
 * wildcard git could expand.
 */
function gitRevPaths(value: string, bases: readonly string[], root: string): string[] | null {
  let path: string;
  if (value.startsWith(":(")) {
    const close = value.indexOf(")");
    if (close === -1) return null;
    path = value.slice(close + 1);
  } else if (value.startsWith(":/")) path = value.slice(2);
  else if (value.startsWith(":")) path = value.slice(1).replace(/^[0-3]:/, "");
  else path = value.slice(value.indexOf(":") + 1);
  if (/[*?[]/.test(path)) return null;
  const out: string[] = [];
  for (const base of bases) {
    if (path === "." || path.startsWith("./") || path.startsWith("../") || path === "..") out.push(resolve(base, path));
    else {
      const top = gitTopLevel(base) ?? root;
      out.push(resolve(top, path.replace(/^\/+/, "")));
    }
  }
  return out;
}

/** The nearest ancestor of `dir` holding `.git`, or null. */
function gitTopLevel(dir: string): string | null {
  let current = dir;
  for (let i = 0; i < 256; i++) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
