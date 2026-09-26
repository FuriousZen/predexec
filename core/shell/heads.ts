/**
 * Read-only command heads for the destructive-command heuristic
 * (core/destructive.ts): the READ_ONLY_HEADS allowlist that lets a segment skip
 * the word scan, and the per-head argv predicates (READ_ONLY_HEAD_WRITES) that
 * catch each reader's own write/exec forms — `sed -n 'w F'`, `sort -o F`,
 * awk `print > F`, `find -exec`, LESSOPEN, and so on.
 */

import {
  ENV_ASSIGNMENT_RE,
  isAppendAssignment,
} from "./lexer.ts";

/**
 * Command heads that only ever read (absent a write/exec form caught by
 * READ_ONLY_HEAD_WRITES below). Membership buys ONE thing: skipping the
 * word-scan, so quoted writer words in their arguments (grep/rg patterns, jq
 * programs) stop false-positive hard-stopping. The redirect check still
 * applies to them.
 */
export const READ_ONLY_HEADS = new Set([
  "cat", "ls", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "file",
  "stat", "du", "df", "ps", "printenv", "echo", "printf", "which",
  "whereis", "type", "pwd", "whoami", "id", "uname", "date", "hostname",
  "sort", "uniq", "cut", "tr", "column", "comm", "join", "paste", "fold",
  "rev", "nl", "od", "xxd", "hexdump", "strings", "basename", "dirname",
  "realpath", "readlink", "md5sum", "sha1sum", "sha256sum", "diff", "cmp",
  "less", "more", "tree", "jq", "yq", "awk", "gawk", "mawk", "sed", "find",
]);

/**
 * Decides whether one invocation of a read-only head writes or execs. Receives
 * the argv AFTER the head (wrappers and env assignments already stripped) and
 * returns the offending token for the hard-stop message, or null when the
 * invocation only reads. `context.inspect` runs a nested command argv
 * (`find -exec`) back through the full classifier; `context.followingText` is
 * the raw command text after this segment (null when it cannot be located).
 */
interface ReadOnlyHeadContext {
  inspect: (argv: string[]) => string | null;
  followingText: string | null;
  /** Leading `NAME=value` assignments (shell prefix or `env`) for this head. */
  assignments: readonly string[];
}
type ReadOnlyHeadWriteCheck = (args: string[], context: ReadOnlyHeadContext) => string | null;

type GetoptArity = "flag" | "value" | "optional";
interface GetoptSpec {
  short: Record<string, GetoptArity>;
  long: Record<string, GetoptArity>;
  /** awk stops at its first operand (the program); sed/sort permute. */
  stopAtOperand?: boolean;
}
type GetoptItem = { kind: "option"; name: string; value?: string } | { kind: "operand"; value: string };

/**
 * GNU getopt_long, as sed/sort/gawk parse their argv: short clusters with
 * attached or following values, and long options abbreviable to any unique
 * prefix (`sed --in` IS `--in-place`). Returns null for anything it cannot
 * resolve — unknown or ambiguous options, a missing value — so callers fail
 * closed instead of guessing where the operands start.
 */
function getopt(args: string[], spec: GetoptSpec): GetoptItem[] | null {
  const items: GetoptItem[] = [];
  const longNames = Object.keys(spec.long);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      for (const rest of args.slice(i + 1)) items.push({ kind: "operand", value: rest });
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const raw = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const matches = longNames.filter((name) => name.startsWith(raw));
      const name = longNames.includes(raw) ? raw : matches.length === 1 ? matches[0]! : null;
      if (name === null) return null;
      const arity = spec.long[name]!;
      if (eq !== -1) {
        if (arity === "flag") return null;
        items.push({ kind: "option", name, value: arg.slice(eq + 1) });
      } else if (arity === "value") {
        if (i + 1 >= args.length) return null;
        items.push({ kind: "option", name, value: args[++i]! });
      } else {
        items.push({ kind: "option", name });
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j]!;
        const arity = spec.short[letter];
        if (arity === undefined) return null;
        if (arity === "flag") {
          items.push({ kind: "option", name: letter });
          continue;
        }
        const attached = arg.slice(j + 1);
        if (attached || arity === "optional") {
          items.push({ kind: "option", name: letter, ...(attached ? { value: attached } : {}) });
        } else {
          if (i + 1 >= args.length) return null;
          items.push({ kind: "option", name: letter, value: args[++i]! });
        }
        break;
      }
      continue;
    }
    items.push({ kind: "operand", value: arg });
    if (spec.stopAtOperand) {
      for (const rest of args.slice(i + 1)) items.push({ kind: "operand", value: rest });
      break;
    }
  }
  return items;
}

function optionNamed(items: GetoptItem[], names: readonly string[]): GetoptItem | undefined {
  return items.find((item) => item.kind === "option" && names.includes(item.name));
}

const SED_GETOPT: GetoptSpec = {
  short: { n: "flag", r: "flag", E: "flag", s: "flag", u: "flag", z: "flag", b: "flag", e: "value", f: "value", l: "value", i: "optional" },
  long: {
    debug: "flag", expression: "value", file: "value", "follow-symlinks": "flag", help: "flag", "in-place": "optional",
    "line-length": "value", "null-data": "flag", "zero-terminated": "flag", posix: "flag", quiet: "flag", silent: "flag",
    "regexp-extended": "flag", sandbox: "flag", separate: "flag", unbuffered: "flag", version: "flag", binary: "flag",
  },
};

/**
 * Scan a sed script for its write/exec commands: `w`/`W` write a file, `e`
 * runs a command, and the `s///w` / `s///e` flags do the same per
 * substitution. Addresses, regexes, and a/i/c text are parsed rather than
 * pattern-matched, so a `w` inside `/w/p` or `s/a/w/` stays data. Anything the
 * parser does not recognise is reported, never skipped.
 */
function sedScriptWrite(script: string): string | null {
  const s = script;
  const n = s.length;
  let i = 0;
  const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  const skipBlank = () => { while (s[i] === " " || s[i] === "\t") i++; };
  const skipDigits = () => { while (isDigit(s[i])) i++; };
  // Consume a delimiter-terminated part (regex, replacement); false if unterminated.
  const delimited = (delimiter: string): boolean => {
    while (i < n) {
      const c = s[i]!;
      if (c === "\\") { i += 2; continue; }
      if (c === delimiter) { i++; return true; }
      if (c === "\n") return false;
      i++;
    }
    return false;
  };
  // true = parsed an address, false = none here, null = malformed.
  const address = (): boolean | null => {
    const c = s[i];
    if (isDigit(c)) {
      skipDigits();
      if (s[i] === "~") { i++; skipDigits(); }
      return true;
    }
    if (c === "$") { i++; return true; }
    if (c === "/" || c === "\\") {
      const delimiter = c === "/" ? "/" : s[i + 1];
      if (delimiter === undefined || delimiter === "\n" || delimiter === "\\") return null;
      i += c === "/" ? 1 : 2;
      if (!delimited(delimiter)) return null;
      while (s[i] === "I" || s[i] === "M") i++;
      return true;
    }
    return false;
  };

  while (i < n) {
    while (i < n && /[\s;]/.test(s[i]!)) i++;
    if (i >= n) break;
    if (s[i] === "#") {
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    const first = address();
    if (first === null) return "sed script";
    if (first) {
      skipBlank();
      if (s[i] === ",") {
        i++;
        skipBlank();
        if (s[i] === "+" || s[i] === "~") {
          i++;
          if (!isDigit(s[i])) return "sed script";
          skipDigits();
        } else if (address() !== true) {
          return "sed script";
        }
      }
    }
    skipBlank();
    while (s[i] === "!") { i++; skipBlank(); }
    const command = s[i];
    if (command === undefined) return "sed script";
    i++;
    switch (command) {
      case "{": case "}":
        continue;
      case "=": case "d": case "D": case "g": case "G": case "h": case "H": case "n": case "N":
      case "p": case "P": case "x": case "z": case "F":
        break;
      case "l": case "L": case "q": case "Q":
        skipBlank();
        skipDigits();
        break;
      case "a": case "i": case "c":
        // Text runs to end of line; a backslash continues it onto the next.
        while (i < n && s[i] !== "\n") i += s[i] === "\\" ? 2 : 1;
        continue;
      case ":": case "b": case "t": case "T": case "v":
        while (i < n && s[i] !== "\n" && s[i] !== ";") i++;
        continue;
      case "r": case "R":
        while (i < n && s[i] !== "\n") i++;
        continue;
      case "w": case "W": case "e":
        return `sed ${command}`;
      case "s": case "y": {
        const delimiter = s[i];
        if (delimiter === undefined || delimiter === "\n" || delimiter === "\\") return "sed script";
        i++;
        if (!delimited(delimiter) || !delimited(delimiter)) return "sed script";
        if (command === "s") {
          while (i < n && /[gpiImM0-9]/.test(s[i]!)) i++;
          if (s[i] === "w" || s[i] === "e") return `sed s///${s[i]}`;
        }
        break;
      }
      default:
        return "sed script";
    }
    skipBlank();
    if (i < n && !/[;\n}#]/.test(s[i]!)) return "sed script";
  }
  return null;
}

const SORT_GETOPT: GetoptSpec = {
  short: {
    b: "flag", d: "flag", f: "flag", g: "flag", i: "flag", M: "flag", h: "flag", n: "flag", R: "flag", r: "flag",
    V: "flag", c: "flag", C: "flag", m: "flag", s: "flag", u: "flag", z: "flag",
    k: "value", o: "value", t: "value", S: "value", T: "value",
  },
  long: {
    "ignore-leading-blanks": "flag", "dictionary-order": "flag", "ignore-case": "flag", "general-numeric-sort": "flag",
    "ignore-nonprinting": "flag", "month-sort": "flag", "human-numeric-sort": "flag", "numeric-sort": "flag",
    "random-sort": "flag", "random-source": "value", reverse: "flag", sort: "value", "version-sort": "flag",
    "batch-size": "value", check: "optional", "compress-program": "value", debug: "flag", "files0-from": "value",
    key: "value", merge: "flag", output: "value", stable: "flag", "buffer-size": "value", "field-separator": "value",
    "temporary-directory": "value", parallel: "value", unique: "flag", "zero-terminated": "flag", help: "flag",
    version: "flag",
  },
};

const AWK_GETOPT: GetoptSpec = {
  short: {
    F: "value", v: "value", f: "value", e: "value", i: "value", l: "value", E: "value", W: "value", Z: "value",
    d: "optional", o: "optional", p: "optional", D: "optional", L: "optional",
    b: "flag", c: "flag", C: "flag", g: "flag", h: "flag", M: "flag", n: "flag", N: "flag", O: "flag", P: "flag",
    r: "flag", s: "flag", S: "flag", t: "flag", V: "flag", Y: "flag",
  },
  long: {
    assign: "value", "field-separator": "value", file: "value", source: "value", include: "value", load: "value",
    exec: "value", "dump-variables": "optional", "pretty-print": "optional", profile: "optional", debug: "optional",
    lint: "optional", persist: "optional", "characters-as-bytes": "flag", traditional: "flag", copyright: "flag",
    "gen-pot": "flag", help: "flag", bignum: "flag", "use-lc-numeric": "flag", "non-decimal-data": "flag",
    optimize: "flag", "no-optimize": "flag", posix: "flag", "re-interval": "flag", sandbox: "flag",
    "lint-old": "flag", version: "flag", csv: "flag", trace: "flag",
  },
  stopAtOperand: true,
};

/**
 * Options that load code from a file (unscannable: -f, -i, -l, -E, mawk -W)
 * or write a file of their own (gawk --dump-variables/--pretty-print/--profile
 * default to awkvars.out / awkprof.out).
 */
const AWK_WRITING_OPTIONS = [
  "f", "file", "i", "include", "l", "load", "E", "exec", "W",
  "d", "dump-variables", "o", "pretty-print", "p", "profile",
];
const AWK_REGEX_KEYWORDS = new Set(["print", "printf", "return", "case", "in"]);

/**
 * Scan an awk program for output redirection and command execution. String
 * and regex literals are masked first, so `"a>b|c"` and `/a|b/` stay data and
 * a comparison like `$1 > 200` outside a print statement stays a comparison.
 * An unterminated literal is reported rather than guessed at.
 */
function awkProgramWrite(program: string): string | null {
  let masked = "";
  // A `/` starts a regex where an operand is expected; after an operand it is
  // division. Postfix `++`/`--` end an operand.
  const regexAllowed = (): boolean => {
    const before = masked.replace(/[ \t]+$/, "");
    if (!before) return true;
    const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before);
    if (word) return AWK_REGEX_KEYWORDS.has(word[0]);
    if (/(?:\+\+|--)$/.test(before)) return false;
    return !/[A-Za-z0-9_\])"/.$]$/.test(before);
  };
  for (let i = 0; i < program.length; i++) {
    const c = program[i]!;
    if (c === "#") {
      while (i + 1 < program.length && program[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "\\" && program[i + 1] === "\n") {
      masked += " ";
      i++;
      continue;
    }
    if (c === '"' || (c === "/" && regexAllowed())) {
      let inBracket = false;
      let closed = false;
      for (i++; i < program.length; i++) {
        const d = program[i]!;
        if (d === "\\") { i++; continue; }
        if (d === "\n") break;
        if (c === "/" && d === "[") inBracket = true;
        else if (c === "/" && d === "]") inBracket = false;
        else if (d === c && !inBracket) { closed = true; break; }
      }
      if (!closed) return "awk program";
      masked += c + c;
      continue;
    }
    masked += c;
  }
  const system = /\bsystem\s*\(|\bclose\s*\(/.exec(masked);
  if (system) return system[0];
  // Any single `|` (not `||`) pipes to or from a command: `print | "sh"`,
  // `print | cmd`, `"cmd" | getline`, gawk's `|&` coprocess.
  if (masked.replace(/\|\|/g, "  ").includes("|")) return "awk |";
  for (const print of masked.matchAll(/\bprintf?\b/g)) {
    const statement = /^[^;\n}]*/.exec(masked.slice(print.index))![0];
    if (statement.includes(">")) return `${print[0]} >`;
  }
  // gawk `@`-syntax other than `@namespace` loads code (`@include`, `@load`)
  // or makes an indirect call (`f = "system"; @f("id")`) that the `system(`
  // check above cannot see.
  const directive = /@(?!namespace\b)[A-Za-z_]*/.exec(masked);
  if (directive) return directive[0];
  return null;
}

const awkWrite: ReadOnlyHeadWriteCheck = (args) => {
  const items = getopt(args, AWK_GETOPT);
  if (items === null) return "awk option";
  const writer = optionNamed(items, AWK_WRITING_OPTIONS);
  if (writer?.kind === "option") return `awk -${writer.name.length > 1 ? "-" : ""}${writer.name}`;
  const sources = items.filter((item) => item.kind === "option" && (item.name === "e" || item.name === "source"));
  const program = sources.length > 0
    ? sources.map((item) => (item as { value: string }).value).join("\n")
    : items.find((item) => item.kind === "operand")?.value;
  return program === undefined ? null : awkProgramWrite(program);
};

/**
 * Whether setting `name` (to `value`, or to an unknown value) makes `less`
 * run a command or write: LESSOPEN/LESSCLOSE are input preprocessors, lesskey
 * sources can set them, and $LESS holds options parsed like argv.
 */
export function lessEnvironmentWrite(name: string, value: string | undefined): boolean {
  if (name === "LESSOPEN" || name === "LESSCLOSE" || name.startsWith("LESSKEY")) return true;
  if (name !== "LESS") return false;
  if (value === undefined) return true;
  // $LESS options may omit the leading dash (`LESS=FRX`).
  const words = value.split(/\s+/).filter(Boolean).map((word) => /^[-+]/.test(word) ? word : `-${word}`);
  return lessArgvWrite(words) !== null;
}

/** xxd options whose value is the next argv item (by xxd's first-letter dispatch). */
const XXD_VALUE_SPELLINGS = new Set(["-cols", "-groupsize", "-len", "-name", "-seek", "-offset"]);

/** less's own write/exec argv forms, shared by its argv and $LESS. */
function lessArgvWrite(args: readonly string[]): string | null {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg.startsWith("+") && !/^\+\+?(?:\d*[GgFjk]?|[/?].*)$/.test(arg)) return "less +cmd";
    if (/^-[^-]/.test(arg) && /[oO]/.test(arg)) return "less -o";
    // -k/--lesskey-*: a lesskey source can set LESSOPEN in its #env section.
    if (/^-[^-]/.test(arg) && arg.includes("k")) return "less -k";
    const long = /^--([^=]+)/.exec(arg);
    if (long && "log-file".startsWith(long[1]!.toLowerCase())) return "less --log-file";
    if (long && /^lessk/i.test(long[1]!)) return "less --lesskey";
  }
  return null;
}

/**
 * Per-head write/exec detectors for READ_ONLY_HEADS, one predicate per head.
 * These run on every segment BEFORE the safe tier, because a read-only head
 * never reaches the word scan that would otherwise catch its writes.
 */
export const READ_ONLY_HEAD_WRITES: Record<string, ReadOnlyHeadWriteCheck> = {
  sed: (args) => {
    const items = getopt(args, SED_GETOPT);
    if (items === null) return "sed option";
    if (optionNamed(items, ["i", "in-place"])) return "sed -i";
    // A script file cannot be inspected from argv.
    if (optionNamed(items, ["f", "file"])) return "sed -f";
    const expressions = items.filter((item) => item.kind === "option" && (item.name === "e" || item.name === "expression"));
    const script = expressions.length > 0
      ? expressions.map((item) => (item as { value: string }).value).join("\n")
      : items.find((item) => item.kind === "operand")?.value;
    return script === undefined ? null : sedScriptWrite(script);
  },
  sort: (args) => {
    const items = getopt(args, SORT_GETOPT);
    if (items === null) return "sort option";
    if (optionNamed(items, ["o", "output"])) return "sort -o";
    if (optionNamed(items, ["compress-program"])) return "sort --compress-program";
    return null;
  },
  awk: awkWrite,
  gawk: awkWrite,
  mawk: awkWrite,
  // xxd writes its second operand (`xxd in out`), and `-r` reverts a dump
  // back into binary. xxd matches options by first letter, so `-revert` is -r.
  xxd: (args) => {
    let i = 0;
    for (; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--") { i++; break; }
      const option = arg.startsWith("--") ? arg.slice(1) : arg;
      if (!option.startsWith("-") || option === "-") break;
      if (option.startsWith("-r")) return "xxd -r";
      if ("cglnosR".includes(option[1]!) && (option.length === 2 || XXD_VALUE_SPELLINGS.has(option))) i++;
    }
    return args.length - i > 1 ? "xxd outfile" : null;
  },
  // --pre runs a preprocessor per file; --hostname-bin runs a program.
  rg: (args) => {
    for (const arg of args) {
      if (arg === "--") break;
      const option = /^--(pre|hostname-bin)(?:=|$)/.exec(arg);
      if (option) return `rg --${option[1]}`;
    }
    return null;
  },
  // -o writes the listing to a file; -R re-runs tree with `-o 00Tree.html` in
  // every directory.
  tree: (args) => {
    for (const arg of args) {
      if (arg === "--") break;
      if (/^-[^-]/.test(arg) && /[oR]/.test(arg)) return "tree -o";
    }
    return null;
  },
  // -exec/-execdir/-ok/-okdir run a command: classify that command in turn
  // (`find -exec grep` still reads). A found file as the command, or any
  // dynamic word (`$VAR`, backticks — re-quoting for the nested classifier
  // would turn them into inert literals), is never read-only. So is an exec
  // with no terminator, unless the missing `;` is an escaped `\;` the segment
  // splitter cut at AND nothing but a separator follows it: otherwise the
  // rest of the find expression (`\; -delete`) was split off unseen.
  find: (args, { inspect, followingText }) => {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (/^-(?:delete|fprint0?|fprintf|fls)$/.test(arg)) return `find ${arg}`;
      if (/^-(?:exec|execdir|ok|okdir)$/.test(arg)) {
        const command: string[] = [];
        let j = i + 1;
        for (; j < args.length; j++) {
          const word = args[j]!;
          // A trailing lone `\` is a `\;` cut at the `;` by a splitter that
          // ignored escapes. splitCommandSegments honors them now (CORE-7), so
          // this should not trigger; it stays as the fail-closed guard (R11a).
          if (word === "\\" && j === args.length - 1) {
            const tail = followingText === null ? null : /^;[ \t]*(?:$|[|&;\n\r])/.exec(followingText);
            if (tail === null) return `find ${arg} \\;`;
            break;
          }
          if (word === ";" || (word === "+" && args[j - 1] === "{}")) break;
          command.push(word);
        }
        if (j >= args.length) return `find ${arg}`;
        if (command.length === 0 || command[0]!.includes("{}") || command.some((word) => /[$`]/.test(word))) {
          return `find ${arg}`;
        }
        const nested = inspect(command);
        if (nested) return nested;
        i = j;
        continue;
      }
      if (/^-(?:exec|ok|fprint|fls)/.test(arg)) return `find ${arg}`;
    }
    return null;
  },
  // -o/-O (clustered or attached) and --log-file/--LOG-FILE, which less
  // accepts abbreviated. `+cmd` runs cmd as an initial command, and less's
  // `!`/`|`/`s` commands exec or write, so only plain positioning/search forms
  // (one line) are allowed. LESSOPEN/LESSCLOSE are input preprocessors
  // (commands) whatever their value, and lesskey sources can set them (and
  // bind keys); $LESS holds options parsed like argv.
  less: (args, { assignments }) => {
    for (const assignment of assignments) {
      const [, name, value] = ENV_ASSIGNMENT_RE.exec(assignment) ?? [];
      if (name !== undefined && lessEnvironmentWrite(name, isAppendAssignment(assignment) ? undefined : value)) return name;
    }
    return lessArgvWrite(args);
  },
  // -i/--inplace rewrites the file; --split-exp writes one file per document.
  yq: (args) => {
    for (const arg of args) {
      if (arg === "--") break;
      if (/^--(?:inplace|in-place|split-exp)(?:=|$)/.test(arg)) return arg.split("=")[0]!;
      if (!/^-[^-]/.test(arg)) continue;
      for (const letter of arg.slice(1)) {
        if (letter === "i" || letter === "s") return `yq -${letter}`;
        // -o/-p/-I take a value; the rest of the cluster is that value.
        if ("opI=".includes(letter)) break;
      }
    }
    return null;
  },
};
