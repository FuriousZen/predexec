/**
 * Interpreter and shell eval invocations for the destructive-command heuristic
 * (core/destructive.ts): each interpreter's eval-flag grammar and preload
 * options (extracting the inline programs it will run), the cheap argv-level
 * preflight that fails oversized payloads closed before recursive inspection,
 * and `sh -c`-style shell eval payload extraction.
 */

import {
  ARGV,
  ENV_ASSIGNMENT_RE,
  lexShellWords,
  normalizeEnvInvocation,
  tokenizeShellWords,
} from "./lexer.ts";
import {
  INTERPRETER_PRELOAD_ENV,
} from "./env.ts";
import {
  type InterpolationLanguage,
  LANGUAGE_EVAL_EARLY_LIMIT,
  MAX_LANGUAGE_ARGUMENT_LENGTH,
  executableLanguageView,
} from "./language-scan.ts";

/** Interpreters whose `-e`/`-c`/`--eval` payload is executable code, not data. */
export const EVAL_INTERPRETERS = new Set(["node", "deno", "bun", "python", "python3", "ruby", "perl", "php"]);
/**
 * Shells whose `-c` argument is a script and which otherwise run a script file
 * or stdin. Not just sh/bash/zsh/dash: `ksh -c 'echo x > f'` hid its write
 * from every screen. Multicall `busybox`/`toybox` is a wrapper (lexer.ts), so
 * `busybox sh` resolves to `sh` here.
 */
export const EVAL_SHELLS = new Set([
  "sh", "bash", "rbash", "zsh", "dash", "ash", "hush", "ksh", "ksh93", "mksh", "pdksh", "oksh", "yash", "posh",
  "csh", "tcsh", "fish",
]);

/**
 * Versioned, distro-alias and alternate-implementation interpreter executables
 * (`python3.12`, `python3.12-dbg`, `pypy3`, `ipython3`, `node22`, `nodejs22`,
 * `perl5.36.0`, `ruby3.3`, `jruby`, `php8.2`, `bun1`, `deno2`) run the same
 * eval grammar and read the same preload variables as their family. Checking
 * only the canonical spelling let `python3.12 -c "os.system(...)"` and
 * `node18 -e 'require("fs").writeFileSync(...)'` skip every interpreter screen.
 */
const INTERPRETER_ALIAS_RE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:i?python|pypy)\d*(?:\.\d+)*[a-z]?(?:-dbg)?$/, "python"],
  [/^node(?:js)?\d*(?:\.\d+)*$/, "node"],
  [/^perl\d+(?:\.\d+)*$/, "perl"],
  [/^(?:j|truffle)?ruby\d*(?:\.\d+)*$/, "ruby"],
  [/^php\d+(?:\.\d+)*$/, "php"],
  [/^bun(?:\d+(?:\.\d+)*|-canary)?$/, "bun"],
  [/^deno(?:\d+(?:\.\d+)*|-canary)?$/, "deno"],
];

/** The interpreter family a (basename) head belongs to; other heads are returned unchanged. */
export function interpreterFamily(head: string): string {
  if (EVAL_INTERPRETERS.has(head)) return head;
  for (const [pattern, family] of INTERPRETER_ALIAS_RE) {
    if (pattern.test(head)) return family;
  }
  return head;
}

type EvalPrograms =
  | { kind: "none" }
  | { kind: "eval"; programs: string[]; join: boolean }
  | { kind: "violation"; reason: string };

/** Modules a `perl -M`/`-m` or `ruby -r` preload may name: loading them runs no repo code. */
const PERL_PRELOAD_MODULES = new Set(["strict", "warnings", "utf8", "JSON::PP", "Data::Dumper", "List::Util"]);
const RUBY_PRELOAD_LIBRARIES = new Set(["json", "set", "pp", "yaml"]);
/** Node options that load code before the eval program runs. */
const NODE_PRELOAD_OPTION_RE =
  /^(?:-r|--require|--import|--loader|--experimental-loader|--preload|--env-file|--env-file-if-exists|--experimental-config-file|--experimental-default-config-file)(?:=|$)/;

/**
 * The inline programs of an interpreter invocation, parsed with each
 * interpreter's own option grammar, without the script arguments that follow
 * (`perl -pe 's/a/b/' FILE`). Clustered switches (`python3 -Ic`, `perl -lane`,
 * `ruby -ne`), attached programs (`-ePROGRAM`, `--eval=PROGRAM`) and repeated
 * eval flags are all collected. Options that load code before the program
 * (`node -r`, `perl -Mmod`, `ruby -rlib`, `php -d`) and options the grammar
 * does not know are violations: an extraction miss must never degrade to "no
 * calls". `none` means the invocation runs a script or nothing inline.
 */
export function interpreterEvalPrograms(segment: string): EvalPrograms {
  const normalized = normalizeEnvInvocation(tokenizeShellWords(segment, ARGV));
  if (!normalized.complete || normalized.argv.length === 0) return { kind: "violation", reason: "ambiguous invocation" };
  const rawHead = normalized.argv[0]!.replace(/^.*\//, "");
  const head = interpreterFamily(rawHead);
  const argv = normalized.argv;
  const programs: string[] = [];
  const violation = (reason: string): EvalPrograms => ({ kind: "violation", reason });
  const result = (join: boolean): EvalPrograms => programs.length > 0 ? { kind: "eval", programs, join } : { kind: "none" };

  const preloadEnv = INTERPRETER_PRELOAD_ENV[head];
  for (const assignment of normalized.assignments) {
    const name = ENV_ASSIGNMENT_RE.exec(assignment)?.[1];
    if (name && preloadEnv?.has(name)) return violation(name);
  }

  if (head === "deno") {
    return argv[1] === "eval" || argv[1] === "run" ? violation(`deno ${argv[1]}`) : { kind: "none" };
  }

  if (head === "python" || head === "python3") {
    for (let i = 1; i < argv.length; i++) {
      const word = argv[i]!;
      if (word === "--" || word === "-" || !word.startsWith("-")) return { kind: "none" };
      if (word.startsWith("--")) {
        if (/^--(?:version|help)$/.test(word)) continue;
        return violation(word);
      }
      for (let j = 1; j < word.length; j++) {
        const letter = word[j]!;
        if (letter === "c") {
          const rest = word.slice(j + 1);
          if (rest) programs.push(rest);
          else if (i + 1 < argv.length) programs.push(argv[++i]!);
          else return violation("-c");
          return result(false);
        }
        if (letter === "m") return { kind: "none" };
        if (letter === "W" || letter === "X") {
          const value = j === word.length - 1 ? argv[++i] : word.slice(j + 1);
          // A warning filter's category (`action:message:category:...`) is
          // imported by name, so a module-qualified one runs that module.
          if (letter === "W" && value !== undefined && (value.split(":")[2] ?? "").includes(".")) {
            return violation(`-W ${value}`);
          }
          break;
        }
        if (!"bBdEhiIOPqsSuvVxR".includes(letter)) return violation(`-${letter}`);
      }
    }
    return { kind: "none" };
  }

  if (head === "perl" || head === "ruby") {
    const isPerl = head === "perl";
    // Per-letter grammar, audited against perl.c/perlrun and ruby.c:
    // - plain switches continue the cluster;
    // - digit-suffixed ones (`-0777`, `-l`, `-CSD`, `-W0`) consume only
    //   their own characters;
    // - attach-only switches (perl -F/-i/-M/-m/-x, ruby -F/-i/-x) take the
    //   rest of the cluster and NEVER the next word, and ruby -K takes one
    //   character and continues;
    // - only perl -e/-E/-I and ruby -e/-E/-r/-I/-C may take the next word.
    const plain = isPerl ? "napsuUtTwWXcvhfgS" : "napslvwdcyUh";
    const digits: Record<string, RegExp> = isPerl
      ? { l: /^[0-7]*/, "0": /^(?:x[0-9a-fA-F]*|[0-7]*)/, C: /^(?:\d+|[IOEioSDAL]*)/ }
      : { "0": /^[0-7]*/, W: /^[0-2:a-z]*/, K: /^[a-zA-Z]?/ };
    const separate = isPerl ? "eEI" : "eErIC";
    const attachOnly = isPerl ? "FiMmx" : "Fix";
    for (let i = 1; i < argv.length; i++) {
      const word = argv[i]!;
      if (word === "--" || word === "-" || !word.startsWith("-")) break;
      if (word.startsWith("--")) {
        if (/^--(?:version|help|verbose|disable-gems|disable=gems)$/.test(word)) continue;
        return violation(word);
      }
      for (let j = 1; j < word.length; j++) {
        const letter = word[j]!;
        if (plain.includes(letter)) continue;
        const digitRe = digits[letter];
        if (digitRe) {
          j += digitRe.exec(word.slice(j + 1))![0].length;
          continue;
        }
        let value = word.slice(j + 1);
        if (separate.includes(letter)) {
          if (!value) {
            if (i + 1 >= argv.length) return violation(`-${letter}`);
            value = argv[++i]!;
            // A switch value spelled like an option means the words were
            // not paired the way we think; fail closed.
            if (value.startsWith("-") && letter !== "e" && letter !== "E") return violation(`-${letter} ${value}`);
          } else if ((letter === "e" || letter === "E") && j === 1) {
            value = attachedEvalProgram(segment, rawHead) ?? value;
          }
        } else if (!attachOnly.includes(letter)) {
          return violation(`-${letter}`);
        }
        if (letter === "e" || letter === "E") programs.push(value);
        else if (isPerl && (letter === "M" || letter === "m")) {
          // perl splices the whole value into `use …;`, so it must be exactly
          // a reader module name with an optional `=import,list`.
          const spec = /^([A-Za-z_][\w:]*)(?:=[\w,:]*)?$/.exec(value);
          if (!spec || !PERL_PRELOAD_MODULES.has(spec[1]!)) return violation(`-${letter}${value}`);
        } else if (!isPerl && letter === "r") {
          if (!RUBY_PRELOAD_LIBRARIES.has(value)) return violation(`-r${value}`);
        } else if (!isPerl && letter === "x") {
          return violation("-x");
        }
        break;
      }
    }
    return result(true);
  }

  if (head === "php") {
    for (let i = 1; i < argv.length; i++) {
      const word = argv[i]!;
      if (word === "--" || !word.startsWith("-")) break;
      const program = /^(?:-[rBRE]|--(?:run|process-begin|process-code|process-end))$/.test(word);
      if (program) {
        if (i + 1 >= argv.length) return violation(word);
        programs.push(argv[++i]!);
        continue;
      }
      if (/^-[nqHhviem]+$/.test(word)) continue;
      return violation(word);
    }
    return result(false);
  }

  // node and bun: options may follow the program, a later `--eval=` replaces
  // an earlier one, and an unknown option may take a separate value, so every
  // eval flag anywhere in argv is collected (a script argument spelled like
  // one fails closed).
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === "--") break;
    if (!word.startsWith("-")) continue;
    if (NODE_PRELOAD_OPTION_RE.test(word)) return violation(word.replace(/=.*$/s, ""));
    const attached = /^--(?:eval|print)=(.*)$/s.exec(word);
    if (attached) {
      programs.push(attached[1]!);
      continue;
    }
    if (/^(?:-e|-p|-pe|-ep|--eval|--print)$/.test(word)) {
      if (i + 1 >= argv.length) return violation(word);
      programs.push(argv[++i]!);
    }
  }
  return result(false);
}

/**
 * Interpreters with no reader allowlist: any program they read on stdin is
 * unvetted code (`tclsh <<< 'exec id'`), so it is never read-only.
 */
const STDIN_UNVETTED_INTERPRETER_RE = /^(?:tclsh|wish|expect)\d*(?:\.\d+)*$/;

export type StdinProgramInvocation =
  | { kind: "none" }
  | { kind: "program"; head: string }
  | { kind: "unvetted"; head: string };

/**
 * Whether a simple command, given a here-string or here-document on stdin,
 * runs that text as a program. An interpreter with no inline `-c`/`-e`
 * program reads its program from stdin (`-` included); with an inline
 * program, stdin is that program's data. A script or `-m` operand is not told
 * apart: its stdin text is scanned as a program too, which can only over-stop.
 * `program` means: scan the stdin text exactly like an inline program of
 * `head`'s language.
 */
export function interpreterStdinProgram(command: string): StdinProgramInvocation {
  const clause = stripShellControlPrefix(command);
  const normalized = normalizeEnvInvocation(tokenizeShellWords(clause, ARGV));
  if (!normalized.complete) return { kind: "unvetted", head: "ambiguous command" };
  if (normalized.argv.length === 0) return { kind: "none" };
  const rawHead = normalized.argv[0]!.replace(/^.*\//, "");
  if (STDIN_UNVETTED_INTERPRETER_RE.test(rawHead)) return { kind: "unvetted", head: rawHead };
  const head = interpreterFamily(rawHead);
  if (!EVAL_INTERPRETERS.has(head)) return { kind: "none" };
  const programs = interpreterEvalPrograms(clause);
  if (programs.kind === "violation") return { kind: "unvetted", head };
  return programs.kind === "eval" ? { kind: "none" } : { kind: "program", head };
}

export function interpreterEvalPayload(segment: string): string {
  const words = tokenizeShellWords(segment, ARGV);
  const normalized = normalizeEnvInvocation(words);
  if (!normalized.complete || normalized.argv.length === 0) return segment;
  const rawHead = normalized.argv[0]!.replace(/^.*\//, "");
  const head = interpreterFamily(rawHead);
  const evalFlag = /^(?:--eval|--print|--run|-r|-[epnc]|-[pn]*e[pn]*)$/;
  const index = normalized.argv.findIndex((word, i) => i > 0 && evalFlag.test(word));
  if (index >= 0) return normalized.argv.slice(index + 1).join(" ");
  // Ruby and Perl accept an eval program attached directly to `-e`, e.g.
  // `ruby -eFile.write(...)`. Keep this narrow: other interpreters have
  // materially different short-option grammars and remain fail-closed below.
  if (head === "ruby" || head === "perl") {
    const attached = normalized.argv.findIndex((word, i) => i > 0 && /^-e.+/.test(word));
    if (attached >= 0) {
      const raw = attachedEvalProgram(segment, rawHead);
      return raw ?? [normalized.argv[attached]!.slice(2), ...normalized.argv.slice(attached + 1)].join(" ");
    }
  }
  return segment;
}

/**
 * Extract an attached Ruby/Perl `-ePROGRAM` while retaining quotes that are
 * part of PROGRAM. ShellWords must remove the shell's outer argument quotes,
 * but attached programs can also use those same delimiters as language
 * string syntax (for example `-eputs("File.write('x','y')")`). A quote that
 * starts before any program text is an outer shell wrapper; quotes encountered
 * after text has started are retained as language syntax.
 */
function attachedEvalProgram(segment: string, interpreter: string): string | null {
  const name = interpreter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\s)(?:[^\\s]*\\/)?${name}\\s+(-e)`).exec(segment);
  if (!match) return null;
  const tokenStart = match.index + match[0]!.indexOf(match[1]!);
  let tokenEnd = tokenStart + match[1]!.length;
  let shellQuote: "'" | '"' | null = null;
  let shellEscaped = false;
  for (; tokenEnd < segment.length; tokenEnd++) {
    const ch = segment[tokenEnd]!;
    if (shellEscaped) { shellEscaped = false; continue; }
    if (ch === "\\" && shellQuote !== "'") { shellEscaped = true; continue; }
    if (shellQuote !== null) {
      if (ch === shellQuote) shellQuote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { shellQuote = ch; continue; }
    if (/\s/.test(ch)) break;
  }
  if (shellQuote !== null || shellEscaped) return null;
  const raw = segment.slice(tokenStart + match[1]!.length, tokenEnd);
  let program = "";
  let quote: "'" | '"' | null = null;
  let preserveQuote = false;
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      program += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        if (preserveQuote) program += ch;
        quote = null;
      } else {
        program += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      preserveQuote = program.length > 0;
      if (preserveQuote) program += ch;
      quote = ch;
      continue;
    }
    program += ch;
  }
  if (escaped || quote !== null) return null;
  return program;
}

export function interpreterLanguage(head: string): InterpolationLanguage {
  if (head === "node" || head === "deno" || head === "bun") return "node";
  if (head === "python3") return "python";
  return head as InterpolationLanguage;
}

/**
 * Cheap argv-aware eval preflight. It intentionally uses the same quote-aware
 * shell word splitter as payload extraction, but does not inspect substitutions
 * or language syntax. A null result means this command is not a direct eval
 * invocation; callers can then proceed with ordinary shell classification.
 */
function directInterpreterEvalPreflight(segment: string): { payloadLength: number; interpreter: string } | null {
  const words = tokenizeShellWords(segment, ARGV);
  const normalized = normalizeEnvInvocation(words);
  if (!normalized.complete || normalized.argv.length === 0) return null;
  const interpreter = interpreterFamily(normalized.argv[0]!.replace(/^.*\//, ""));
  if (!EVAL_INTERPRETERS.has(interpreter)) return null;
  const evalFlag = /^(?:--eval|--print|--run|-r|-[epnc]|-[pn]*e[pn]*)$/;
  let flagIndex = normalized.argv.findIndex((word, i) => i > 0 && evalFlag.test(word));
  if (flagIndex < 0 && (interpreter === "ruby" || interpreter === "perl")) {
    flagIndex = normalized.argv.findIndex((word, i) => i > 0 && /^-e.+/.test(word));
    if (flagIndex >= 0) {
      return { interpreter, payloadLength: [normalized.argv[flagIndex]!.slice(2), ...normalized.argv.slice(flagIndex + 1)].join(" ").length };
    }
  }
  if (flagIndex < 0) return null;
  return { interpreter, payloadLength: normalized.argv.slice(flagIndex + 1).join(" ").length };
}

export function stripShellControlPrefix(fragment: string): string {
  let current = fragment.trim();
  for (let i = 0; i < 8; i++) {
    const next = current.replace(/^(?:(?:if|then|elif|else|fi|while|until|do|done|for|select|function|coproc)\b|[!{}()])\s*/u, "");
    if (next === current) break;
    current = next;
  }
  return current;
}

interface CheapScanBudget { remaining: number; exhausted: boolean; }

function chargeCheapScan(budget: CheapScanBudget): boolean {
  if (budget.remaining <= 0) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining--;
  return true;
}

function cheapGroupClose(
  command: string,
  start: number,
  open: string,
  close: string,
  budget: CheapScanBudget,
): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = start + 1; i < command.length; i++) {
    if (!chargeCheapScan(budget)) return -2;
    const ch = command[i]!;
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (quote === '"') {
      if (ch === "\\") {
        if (i + 1 < command.length && !chargeCheapScan(budget)) return -2;
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < command.length && !chargeCheapScan(budget)) return -2;
      i++;
      continue;
    }
    if (ch === "'") { quote = "'"; continue; }
    if (ch === '"') { quote = '"'; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

/**
 * Lightweight command-fragment extraction for the eval-size guard. This is
 * intentionally not the shared shell parser: it only tracks quotes, joins,
 * and substitution/group delimiters, then delegates argv interpretation to
 * the existing direct preflight. Its bounded recursion keeps oversized evals
 * out of the more expensive executable-body tree.
 */
function cheapInterpreterFragments(
  command: string,
  depth = 0,
  budget: CheapScanBudget = { remaining: LANGUAGE_EVAL_EARLY_LIMIT * 8, exhausted: false },
): string[] | null {
  if (depth > 16 || budget.exhausted || command.length > budget.remaining) {
    budget.exhausted = true;
    return null;
  }
  budget.remaining -= command.length;
  const fragments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  const isCaseCommand = /^\s*case\b[\s\S]*\bin\b/u.test(command);
  for (let i = 0; i < command.length; i++) {
    if (!chargeCheapScan(budget)) return null;
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        if (i + 1 < command.length && !chargeCheapScan(budget)) return null;
        i++;
        continue;
      }
      if (ch === '"') { quote = null; continue; }
      continue;
    } else if (ch === "\\") {
      if (i + 1 < command.length && !chargeCheapScan(budget)) return null;
      i++;
      continue;
    } else if (ch === "'") {
      quote = "'";
      continue;
    } else if (ch === '"') {
      quote = '"';
      continue;
    }

    const substitution = (ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(";
    if (substitution) {
      const bodyStart = i + 2;
      let parens = 1;
      let innerQuote: "'" | '"' | null = null;
      let close = -1;
      for (let j = bodyStart; j < command.length; j++) {
        if (!chargeCheapScan(budget)) return null;
        const inner = command[j]!;
        if (innerQuote === "'") { if (inner === "'") innerQuote = null; continue; }
        if (innerQuote === '"') {
          if (inner === "\\") {
            if (j + 1 < command.length && !chargeCheapScan(budget)) return null;
            j++;
            continue;
          }
          if (inner === '"') innerQuote = null;
          continue;
        }
        if (inner === "\\") {
          if (j + 1 < command.length && !chargeCheapScan(budget)) return null;
          j++;
          continue;
        }
        if (inner === "'") { innerQuote = "'"; continue; }
        if (inner === '"') { innerQuote = '"'; continue; }
        if (inner === "(") parens++;
        else if (inner === ")" && --parens === 0) { close = j; break; }
      }
      if (close >= 0) {
        const nested = cheapInterpreterFragments(command.slice(bodyStart, close), depth + 1, budget);
        if (nested === null) return null;
        fragments.push(...nested);
        i = close;
      }
      continue;
    }
    if (ch === "(" || ch === "{") {
      const close = cheapGroupClose(command, i, ch, ch === "(" ? ")" : "}", budget);
      if (close === -2) return null;
      if (close >= 0) {
        const nested = cheapInterpreterFragments(command.slice(i + 1, close), depth + 1, budget);
        if (nested === null) return null;
        fragments.push(...nested);
        i = close;
      }
      continue;
    }
    if (ch === "`") {
      let close = -1;
      for (let j = i + 1; j < command.length; j++) {
        if (!chargeCheapScan(budget)) return null;
        if (command[j] === "\\") {
          if (j + 1 < command.length && !chargeCheapScan(budget)) return null;
          j++;
          continue;
        }
        if (command[j] === "`") { close = j; break; }
      }
      if (close >= 0) {
        const nested = cheapInterpreterFragments(command.slice(i + 1, close), depth + 1, budget);
        if (nested === null) return null;
        fragments.push(...nested);
        i = close;
      }
      continue;
    }
    // A case arm starts after its unquoted `pattern)` delimiter rather than
    // after a command separator. Expose that arm as a fresh command fragment
    // while leaving ordinary parenthesized groups to the branch above.
    if (ch === ")" && isCaseCommand) {
      start = i + 1;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "\r") {
      if (command.slice(start, i).trim()) fragments.push(command.slice(start, i));
      start = i + 1;
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
      if (ch === "\r" && command[i + 1] === "\n") i++;
    }
  }
  if (command.slice(start).trim()) fragments.push(command.slice(start));
  return fragments;
}

export function interpreterEvalPreflight(segment: string): { payloadLength: number; interpreter: string } | null {
  const direct = directInterpreterEvalPreflight(segment);
  if (direct) return direct;
  const fragments = cheapInterpreterFragments(segment);
  if (fragments === null) return { interpreter: "shell", payloadLength: LANGUAGE_EVAL_EARLY_LIMIT + 1 };
  for (const fragment of fragments) {
    const candidate = directInterpreterEvalPreflight(stripShellControlPrefix(fragment));
    if (candidate) return candidate;
  }
  return null;
}

export function languageWordScanSegment(head: string, segment: string): string {
  if (!isEvalInvocation(head, segment) || !EVAL_INTERPRETERS.has(head)) return segment;
  const payload = interpreterEvalPayload(segment);
  const language = interpreterLanguage(head);
  const view = executableLanguageView(payload, language);
  return view === null ? segment : `${head} ${view}`;
}
interface ShellEvalPayload {
  /** The static `-c` script, or null when there is none or it cannot be known. */
  payload: string | null;
  /** The invocation could not be parsed with confidence (fail closed). */
  ambiguous: boolean;
  /** No `-c`: the shell runs a script file or reads commands from stdin. */
  runsScript: boolean;
}

interface ShellArgvWord {
  value: string;
  dynamic: boolean;
}

/** Shell long options that take no argument (bash's documented set). */
const SHELL_LONG_OPTIONS: ReadonlySet<string> = new Set([
  "--norc", "--noprofile", "--login", "--posix", "--noediting", "--restricted", "--verbose", "--protected", "--debugger",
]);
/** Shell long options whose argument is the next word (or attached with `=`). */
const SHELL_LONG_OPTIONS_WITH_ARGUMENT: ReadonlySet<string> = new Set(["--rcfile", "--init-file"]);
/** Options that print and exit without running any commands. */
const SHELL_INFO_OPTIONS: ReadonlySet<string> = new Set(["--version", "--help"]);

const AMBIGUOUS_SHELL: ShellEvalPayload = { payload: null, ambiguous: true, runsScript: false };

/**
 * Parse a shell's argv (after the head) the way sh/bash/zsh/dash do: option
 * words until `--`, `-`, or the first operand. Short clusters (`-lc`, `-eo`,
 * `+O`) set `c` (command mode) and consume one following word per `o`/`O`;
 * `--rcfile`/`--init-file` consume theirs. In command mode the first operand
 * is the script; `bash -c -- 'x'` runs `x`. Any other long or malformed option
 * is ambiguous: guessing its arity is how a script hid behind `--norc`.
 */
function parseShellArgv(words: readonly ShellArgvWord[]): ShellEvalPayload | null {
  let command = false;
  let i = 0;
  for (; i < words.length; i++) {
    const { value, dynamic } = words[i]!;
    if (dynamic) return AMBIGUOUS_SHELL;
    if (value === "--" || value === "-") {
      i++;
      break;
    }
    if (SHELL_INFO_OPTIONS.has(value)) return null;
    if (value.startsWith("--")) {
      if (SHELL_LONG_OPTIONS.has(value)) continue;
      // fish spells -c as `--command SCRIPT` / `--command=SCRIPT`.
      if (value === "--command" || value.startsWith("--command=")) {
        const script = value === "--command" ? words[i + 1] : { value: value.slice("--command=".length), dynamic: false };
        if (!script || script.dynamic || script.value.length > MAX_LANGUAGE_ARGUMENT_LENGTH) return AMBIGUOUS_SHELL;
        return { payload: script.value, ambiguous: false, runsScript: false };
      }
      const attached = value.indexOf("=");
      if (SHELL_LONG_OPTIONS_WITH_ARGUMENT.has(attached === -1 ? value : value.slice(0, attached))) {
        if (attached === -1) i++;
        continue;
      }
      return AMBIGUOUS_SHELL;
    }
    if (/^[-+][A-Za-z]+$/.test(value)) {
      for (const letter of value.slice(1)) {
        if (letter === "c") command = true;
        else if (letter === "o" || letter === "O") i++;
      }
      continue;
    }
    if (/^[-+]/.test(value)) return AMBIGUOUS_SHELL;
    break;
  }
  if (!command) return { payload: null, ambiguous: false, runsScript: true };
  const operand = words[i];
  if (!operand || operand.dynamic || operand.value.length > MAX_LANGUAGE_ARGUMENT_LENGTH) return AMBIGUOUS_SHELL;
  return { payload: operand.value, ambiguous: false, runsScript: false };
}

/**
 * Parse an actual shell invocation, through wrappers: its static `-c` script,
 * or whether it runs a script file / stdin. Null when the segment is not a
 * shell invocation or only prints information (`bash --version`).
 */
export function shellEvalPayload(segment: string): ShellEvalPayload | null {
  const parsed = lexShellWords(segment);
  if (!parsed.complete) return null;
  const tokens = parsed.words.map((word) => word.value);
  const normalized = normalizeEnvInvocation(tokens);
  if (!normalized.complete) return AMBIGUOUS_SHELL;
  if (normalized.argv.length === 0) return null;
  const head = normalized.argv[0]!.replace(/^.*\//, "");
  if (!EVAL_SHELLS.has(head)) return null;

  // Prefer the raw words: they carry whether each one is dynamic.
  const rawHeadIndex = tokens.findIndex((token) => token.replace(/^.*\//, "") === head);
  if (rawHeadIndex >= 0) return parseShellArgv(parsed.words.slice(rawHeadIndex + 1));
  return parseShellArgv(normalized.argv.slice(1).map((value) => ({ value, dynamic: /[$`]/.test(value) })));
}

/**
 * In-place edit flags: `perl -i`, `perl -pi -e`, `ruby -i -pe` rewrite their
 * input files directly. There is no redirect and no blocklisted word, so
 * nothing else in the pipeline catches them.
 */
export const INPLACE_EDIT_RE = /\s-\w*i(\.\w+)?\b/;

export function isEvalInvocation(head: string, segment: string): boolean {
  // `-p`/`-n`/`--print` are eval flags too: `node -p 'require("fs").rmSync(…)'`
  // executes exactly like `-e`, and clustered forms (`perl -pi -e`) are common.
  // Shell quotes may surround the complete `-ePROGRAM` token, so use the
  // argv-aware preflight before falling back to the legacy raw spelling.
  if (EVAL_INTERPRETERS.has(head)) {
    const evaluation = directInterpreterEvalPreflight(segment);
    if (evaluation?.interpreter === head) return true;
    if (head === "php") return /\s(?:-\w*r\w*|--run)\b/.test(segment);
    return /\s(-\w*[ecnp]\w*|--eval|--print)\b/.test(segment);
  }
  if (EVAL_SHELLS.has(head)) return /\s-c\b/.test(segment);
  return false;
}
