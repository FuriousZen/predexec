/**
 * Perl's magic-open channel (R31).
 *
 * `<>`, `<ARGV>`, `readline(ARGV)`, `eof()` and the `-n`/`-p` loops open each
 * element of `@ARGV` with 2-argument `open`, which reads a leading `<`, `>`,
 * `+` or whitespace as a mode and runs a trailing-`|` name as a shell
 * command. So a perl program that reads this channel is only as safe as the
 * names in `@ARGV`:
 *
 * - a program that can influence the list (any `ARGV` write or alias in any
 *   spelling, glob assignment, stash access, symbolic dereference, `eval`,
 *   `do`, `require`) may open anything, including a pipe;
 * - a command-line operand spelled like a mode or a pipe is opened as one.
 *
 * Both are mutating. `<<>>` opens with 3-argument `open` and is safe on its
 * own. Every check here over-approximates: a construct it cannot rule out
 * counts. Pure TS, linear-time regex scans only.
 */

import { ARGV, lexShellWords, stripLeadingAssignmentsAndWrappers } from "./lexer.ts";
import { interpreterEvalPrograms, interpreterFamily, stripShellControlPrefix } from "./interpreters.ts";
import { executableLanguageView } from "./language-scan.ts";

/**
 * True when a perl program may read the magic-open channel. Over-approximate:
 * any readline-like operator (`<FH>`/`<$fh>` may read an ARGV alias), any
 * read/eof builtin, any `ARGV` in the raw text, and a `#!` line (perl takes
 * `-n`/`-p` from it).
 */
export function perlUsesMagicOpen(text: string, view: string, loop: boolean): boolean {
  if (loop || text.includes("#!") || text.includes("ARGV")) return true;
  if (/(?<!<)<\s*(?:\$?[A-Za-z_][\w:]*)?\s*>(?!>)/.test(view)) return true;
  return /\b(?:readline|eof|getc|read|sysread)\b/.test(view);
}

/** `ARGV` mentions that only read the channel or the current file name. */
const ARGV_READS_RE =
  /<\s*ARGV\s*>|\b(?:readline|eof)\s*\(?\s*\*?ARGV\s*\)?|(?<![\w$@%*&\\#:'{}])\$ARGV(?![\w:'[{]|\s*(?:[[{]|->))/g;

/**
 * Symbolic dereference that needs no operator-position context: a sigil block
 * around anything but a plain name, `@$x`, `$$x`, or an arrow deref (a string
 * `"ARGV"->[0]` is `$ARGV[0]` under `no strict refs`).
 */
const SYMBOLIC_DEREF_RES = [/[@$%*&]\s*\{(?!\s*\^?[A-Za-z_]\w*\s*\})/, /@\s*\$|\$\s*\$(?=\s*[\w{$:])/, /->\s*[[{@$%*&(]/];

/** Stash access: `%::`, `%main::`, `$::{…}`, `$main::{…}`, `*::{…}`. */
const STASH_RE = /[$@%*&]\s*(?:(?:main)?(?:::|'))+(?![\w'])/;

/**
 * True when the `*`, `%` or `&` at `at` follows a complete operand, so it is
 * an infix operator (`$x * $y`, `$F[0] % 2`, `f() & $m`). After a bare word
 * it follows a function or keyword (`local *F`, `keys %$h`), so it starts a
 * term.
 */
function followsOperand(view: string, at: number): boolean {
  let prev = at - 1;
  while (prev >= 0 && /\s/.test(view[prev]!)) prev--;
  if (prev < 0) return false;
  const before = view[prev]!;
  if (before === ")" || before === "]" || before === "}") return true;
  if (!/\w/.test(before)) return false;
  let start = prev;
  while (start > 0 && /\w/.test(view[start - 1]!)) start--;
  return /[$@%&]/.test(view[start - 1] ?? "") || /^\d/.test(view.slice(start, prev + 1));
}

/**
 * A `*`, `%` or `&` in term position that dereferences a scalar (`*$g`,
 * `%$h`, `&$f`) or names a typeglob (`*F = …`, `(*F) = …`, `local *F`,
 * `\*F`). A glob right after `}` starts a new statement (`BEGIN {} *F = …`).
 */
function termSigilHazard(view: string): string | null {
  for (const match of view.matchAll(/[*%&]/g)) {
    const at = match.index!;
    const sigil = view[at]!;
    if (view[at - 1] === sigil || view[at + 1] === sigil) continue; // `**`, `&&`, `%%`
    let next = at + 1;
    while (next < view.length && /\s/.test(view[next]!)) next++;
    const after = view[next] ?? "";
    const glob = sigil === "*" && /[A-Za-z_:'{]/.test(after);
    if (followsOperand(view, at)) {
      let prev = at - 1;
      while (prev >= 0 && /\s/.test(view[prev]!)) prev--;
      if (glob && view[prev] === "}" && after !== "{") return "glob assignment";
      continue;
    }
    if (after === "$") return "symbolic dereference";
    if (glob) return "glob assignment";
  }
  return null;
}

/**
 * Why a perl program may change which names the magic-open channel opens, or
 * null when it cannot. `view` is the program's executable view (strings
 * blanked, interpolation bodies kept); `ARGV` mentions are counted in the RAW
 * text, strings included, since a string can name the glob.
 */
export function perlArgvInfluence(text: string, view: string): string | null {
  if (text.replace(ARGV_READS_RE, " ").includes("ARGV")) return "ARGV write or alias";
  const dynamic = /\b(?:eval|do|require)\b/.exec(view);
  if (dynamic) return dynamic[0];
  if (SYMBOLIC_DEREF_RES.some((re) => re.test(view))) return "symbolic dereference";
  if (STASH_RE.test(view)) return "stash access";
  return termSigilHazard(view);
}

/**
 * A command-line word 2-argument `open` would not open as a plain file read:
 * a pipe, a mode prefix, a leading `-` (a lone `-` is stdin) or edge
 * whitespace. A shell-expanded or glob word is unknown, so it counts too.
 */
export function perlMagicOpenOperandHazard(word: string, dynamic: boolean): boolean {
  if (word === "-") return false;
  if (dynamic || /[*?[]/.test(word)) return true;
  return word.includes("|") || /^[<>+-]/.test(word) || /^\s|\s$/.test(word);
}

/**
 * The classifier's check for one command segment: a perl invocation whose
 * program may read the magic-open channel is mutating when the program can
 * influence `@ARGV` or a command-line operand is not a plain file name. A
 * script or stdin program is unseen here, so it is assumed to read the
 * channel (its operands are checked; a stdin program's text is judged by
 * `perlStdinProgramHazard`).
 */
export function perlMagicOpenHazard(segment: string): string | null {
  const clause = stripShellControlPrefix(segment);
  const lex = lexShellWords(clause, ARGV);
  if (!lex.complete) return null; // judged elsewhere
  // Redirections are not argv: drop each operator and its target.
  const words: { value: string; dynamic: boolean }[] = [];
  for (let i = 0; i < lex.words.length; i++) {
    const word = lex.words[i]!;
    const raw = clause.slice(word.start, word.end);
    const operator = REDIRECT_OPERATOR_RE.exec(raw);
    if (operator) {
      if (operator[0].length === raw.length) i++;
      continue;
    }
    words.push(word);
  }
  const stripped = stripLeadingAssignmentsAndWrappers(words.map((word) => word.value));
  const head = stripped[0]?.replace(/^.*\//, "");
  if (head === undefined || interpreterFamily(head) !== "perl") return null;
  // Re-quoted verbatim, so the grammar sees exactly these words.
  const extracted = interpreterEvalPrograms(stripped.map((word) => `'${word.replace(/'/g, `'\\''`)}'`).join(" "));
  if (extracted.kind === "violation" || extracted.perl === undefined) return null; // judged elsewhere
  let channel = extracted.kind !== "eval" || extracted.perl.loop;
  if (extracted.kind === "eval") {
    const text = extracted.programs.join("\n");
    const view = executableLanguageView(text, "perl");
    if (view === null) return "perl eval payload";
    channel ||= perlUsesMagicOpen(text, view, extracted.perl.loop);
    if (!channel) return null;
    const influence = perlArgvInfluence(text, view);
    if (influence) return `perl magic open: ${influence}`;
  }
  // Operands are the argv tail; `words` ends with the same words.
  const tail = words.slice(words.length - extracted.perl.operands.length);
  for (const word of tail) {
    if (perlMagicOpenOperandHazard(word.value, word.dynamic)) return `perl magic open operand ${word.value.slice(0, 64)}`;
  }
  return null;
}

/** An unquoted redirection operator at the start of a word (`<`, `2>`, `<<<`, `&>`, `3<&0`, `>|`). */
const REDIRECT_OPERATOR_RE = /^\d*(?:<<<|<<-?|<>|<&|>&|>>|>\||<|>)|^&>>?/;

/**
 * A perl program read from a here-string or heredoc (`perl - ARGS <<'EOF'`):
 * the same influence check, with the clause's `-n`/`-p` loop.
 */
export function perlStdinProgramHazard(clause: string, program: string): string | null {
  const extracted = interpreterEvalPrograms(stripShellControlPrefix(clause));
  const loop = extracted.kind !== "violation" && (extracted.perl?.loop ?? false);
  const view = executableLanguageView(program, "perl");
  if (view === null) return "perl stdin program";
  if (!perlUsesMagicOpen(program, view, loop)) return null;
  const influence = perlArgvInfluence(program, view);
  return influence ? `perl magic open: ${influence}` : null;
}
