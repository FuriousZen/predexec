/**
 * predexec core — destructive-command heuristic.
 *
 * PURE TS, zero harness imports. Best-effort blocklist with an allowlist tier —
 * NOT a sandbox. Three-way classification per shell command:
 *
 *   1. redirect check (always): an unquoted `>` outside comparison spans writes.
 *   2. safe tier: when EVERY pipeline segment's head is a known pure reader
 *      (and no per-head exception fires), the word-scan is SKIPPED — so
 *      `grep "rm -rf" src/` (searching a codebase for writer words) is not
 *      misread as a write.
 *   3. otherwise: the word blocklist; plus, for interpreter eval flags
 *      (`node -e`, `python -c`, `sh -c`, …), an extra fs-writer-API scan —
 *      the quoted payload is executable there, not data — and then a reader
 *      allowlist: an inline program is mutating unless every call it makes
 *      is a known reader (READER_ALLOWLISTS).
 *
 * Heredoc masking can no longer hide a line from classification:
 * findDestructiveToken also classifies the command with masking off (every
 * physical line as command text) and stops if either pass does (R18).
 *
 * This module is the pipeline; the tables and per-concern scanners live in
 * core/shell/: heads.ts (READ_ONLY_HEADS + per-head argv predicates, and
 * WRITER_HEAD_MODES for mode-sensitive writers such as tar/unzip/gzip), git.ts,
 * env.ts (command-bearing environment variables), interpreters.ts (eval-flag
 * grammars, preflight, shell eval payloads), language-scan.ts (inline program
 * scanning), reader-allowlists.ts, and taint.ts (arithmetic over data-derived
 * variables, the pipeline's last stage).
 *
 * Deliberately out of scope: allowlist-only inversion for commands in general
 * (the adapters' `mutates` guidance wants tests/builds speculating), and
 * rsync (mode-sensitive parsing).
 */

import {
  ARGV,
  blankQuotedAngles,
  commandStdin,
  effectiveHead,
  envOption,
  extractShellCommandClauses,
  hasAnsiCEscapedQuote,
  hasDynamicCommandName,
  heredocScanHazard,
  withoutHeredocMasking,
  inspectCommandSubstitutions,
  inspectCommandSubstitutionTree,
  inspectShellCommandClauses,
  longestWordLength,
  maskHeredocBodies,
  normalizeEnvInvocation,
  parenthesizedBodies,
  splitCommandSegments,
  tokenizeShellWords,
  WRAPPER_DURATION_RE,
  WRAPPER_OPTIONS_WITH_VALUE,
  wrapperOptionHasAttachedValue,
  WRAPPERS,
  WRAPPERS_WITH_DURATION,
} from "./shell/lexer.ts";
import { MAX_CLASSIFY_WORD_LENGTH, MAX_COMMAND_LENGTH, TOOL_NAMES } from "./types.ts";
import {
  findGitMutationToken,
} from "./shell/git.ts";
import {
  READ_ONLY_HEADS,
  READ_ONLY_HEAD_WRITES,
  WRITER_HEAD_MODES,
} from "./shell/heads.ts";
import {
  commandBearingEnvironmentSetting,
  shellEnvironmentPrefixMutation,
} from "./shell/env.ts";
import {
  EVAL_WRITER_RE,
  type InterpolationLanguage,
  LANGUAGE_EVAL_EARLY_LIMIT,
  MAX_LANGUAGE_ARGUMENT_LENGTH,
  executableLanguageView,
  scanLanguagePayload,
} from "./shell/language-scan.ts";
import {
  interpreterReaderViolation,
} from "./shell/reader-allowlists.ts";
import { findTaintedEvaluation } from "./shell/taint.ts";
import {
  EVAL_INTERPRETERS,
  interpreterFamily,
  EVAL_SHELLS,
  INPLACE_EDIT_RE,
  interpreterEvalPayload,
  interpreterEvalPreflight,
  interpreterEvalPrograms,
  interpreterLanguage,
  interpreterStdinProgram,
  isEvalInvocation,
  languageWordScanSegment,
  shellEvalPayload,
  stripShellControlPrefix,
} from "./shell/interpreters.ts";

// The interpreter budgets and eval preflight moved to core/shell/ with the rest
// of the language scanning; re-exported so this module's surface is unchanged.
export {
  LANGUAGE_CALL_CANDIDATE_BUDGET,
  LANGUAGE_EVAL_EARLY_LIMIT,
  LANGUAGE_INTERPOLATION_DEPTH_BUDGET,
  LANGUAGE_VIEW_CHARACTER_BUDGET,
  LANGUAGE_VIEW_WORK_BUDGET,
} from "./shell/language-scan.ts";
export { interpreterEvalPreflight } from "./shell/interpreters.ts";

/** Tool names that are definitively read-only — no regex analysis needed. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);
/** Tool names that are definitively mutating — hard-stop unconditionally. */
export const MUTATING_TOOLS = new Set(["edit", "write"]);

/**
 * Neutralize `>`/`<` where they are comparisons, not file redirects, so a read
 * is not misread as a write: inside shell quoted spans (awk/sed/jq programs and
 * grep patterns — e.g. `awk '$1 > 200'`, `grep "a->b" f`), `[[ ... ]]` tests, and
 * `(( ... ))` arithmetic. Only the angle brackets in those spans are dropped —
 * the rest of the span is kept, so a genuinely destructive word inside quotes
 * (`sh -c 'rm -rf /'`) is still caught by the word scan. Real redirects
 * (`echo x > f`) live OUTSIDE these spans and are untouched. Bare `test`/`[`
 * are left alone: outside `[[ ]]`, `test $x > 5` IS a real redirect to a file
 * named `5`.
 */
function sanitizeForRedirect(cmd: string): string {
  const dropAngles = (s: string) => s.replace(/[<>]/g, " ");
  // Quoted spans come from the backslash-aware lexer walker, not a
  // `'[^']*'` regex: an escaped quote (`echo \' > out \'`) opens no span, so
  // the redirect between two of them stays visible.
  return blankQuotedAngles(maskHeredocBodies(cmd))
    .replace(/\[\[[\s\S]*?\]\]/g, dropAngles)
    .replace(/\(\([\s\S]*?\)\)/g, dropAngles);
}

/**
 * Unquoted `>` that is a real file redirect.
 *
 * Guards live in the LOOKAHEAD: `2>&1` / `>&2` (fd dup) and `>=` are excluded by
 * `[&=]`, and `>/dev/null` by the /dev/null branch. The lookbehind only has to
 * exclude JS arrow functions (`=>`). It must NOT exclude a leading digit — an
 * explicit fd write like `echo hi 1>out.txt` or `2>err.log` is a real file write,
 * and excluding `\d` let every numbered-fd redirect through.
 */
const REDIRECT_RE = /(?<!=)>(?!\s*\/dev\/null(?=\s|$|[|;&<>\n\r])|[=]|&\s*(?:\d+|-|\/dev\/null)(?=\s*(?:$|[|;&<>\n\r])))/;

/**
 * Word blocklist: file removers/movers/creators, process killers, `cp -`,
 * `cp`, `sed -i` / `sort -o` anywhere in their segment, `tee`, `wget` (unless stdout
 * mode `-O-`/`-qO-`), `curl` with a file-output flag (`-o`/`-O`, incl.
 * clustered), `find -delete`, `crontab` (unless `-l` list), package-manager
 * installs/removes, and history-mutating git verbs.
 */
const WORD_RE = new RegExp(
  [
    // file removers/movers/creators, process killers
    /\b(rm|rmdir|mv|dd|mkfs|chmod|chown|truncate|touch|mkdir|ln|shred|unlink|tee)\b/,
    /\b(kill|pkill|killall)\b/,
    /\bcp\b/,
    /\bsed\b[^|;&]*?\s-i\b/,
    /\bsort\b[^|;&]*?\s-o\b/,
    // `install` as a command (coreutils install copies+chmods); not `npm install`,
    // which the package-manager branch already covers.
    /(?<!\w[- ])\binstall\b\s+-/,
    // wget unless stdout mode (-O- / -qO-)
    /\bwget\b(?![^|;&]*-q?O\s?-(?:\s|$|[|;&]))/,
    // curl with a file-output flag: clustered short (-o/-O/-sLo) or long form.
    // The old pattern was `\s-\w*[oO]\b`, where `\w*` could not consume the
    // second dash, so `--output` slipped through.
    /\bcurl\b[^|;&]*\s(--output\b|--remote-name\b|-\w*[oO]\b)/,
    // piping a download straight into an interpreter — the classic installer
    // one-liner. Neither tier caught this: no redirect, no blocklisted word.
    /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|python3?|node|ruby|perl)\b/,
    /\bfind\b[^|;&]*\s-delete\b/,
    /\bcrontab\b(?!\s+-l\b)/,
    // package managers — install/remove plus the lockfile/link/upgrade verbs
    /\b(npm|pnpm|yarn|bun|pip|pip3|apt|apt-get|brew|cargo|go|gem|poetry|composer)\s+(install|add|i|ci|remove|uninstall|rm|update|upgrade|link|dlx|prune)\b/,
    /\bnpx\b/,
    // Any python/pypy alias (`python3.12`, `pypy3`), not just the canonical heads.
    /\b(?:python|pypy)[\d.]*[a-z]?(?:-dbg)?\s+(-m\s*pip|setup\.py)\b/,
    /\bmake\s+install\b/,
    // history-mutating git verbs. Option tokens may sit between `git` and the
    // verb (`git -C /repo reset --hard`, `git -c k=v commit`), so allow them.
    // Read-only spellings are carved back out with negative lookaheads.
    new RegExp(
      String.raw`\bgit\s+(?:-\w+(?:\s+\S+)?\s+|--[\w-]+(?:=\S+)?\s+)*` +
        String.raw`(push|commit|reset|checkout|clean|rm|mv|merge|rebase|restore|switch|apply|am|` +
        String.raw`cherry-pick|revert|gc|prune|filter-branch|worktree|submodule|` +
        String.raw`stash(?!\s+(list|show))|branch(?!\s+(-l\b|--list|-v\b))|tag(?!\s+-l\b)|` +
        String.raw`config(?!\s+(--get|--list|-l\b))|remote(?!\s+(-v\b|show\b)))\b`,
    ),
  ]
    .map((r) => r.source)
    .join("|"),
);

/** Shell builtins that evaluate or replace command text rather than reading it. */
const SHELL_COMMAND_CONTROL_HEADS = new Set(["eval", "source", ".", "exec"]);

/** Quote an argv word for re-classification as shell text. */
function shellQuoteWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./{}-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Subshell/process-substitution markers: content we cannot attribute to a head. */
const OPAQUE_SUBSHELL_RE = /\$\(|`|<\(|>\(/;

/**
 * Return the output option from a leading `time` wrapper, if present. Unlike
 * format-only options, `time -o FILE` and `time --output=FILE` open FILE
 * themselves before running the wrapped command, so resolving the inner head
 * first would incorrectly classify `time -o FILE printf ...` as a safe reader.
 */
function timeOutputOption(segment: string): string | null {
  const tokens = tokenizeShellWords(segment, ARGV);
  let wrapper: string | null = null;
  let pendingDuration = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^\w+=/.test(token)) continue;
    if (pendingDuration && !token.startsWith("-")) {
      pendingDuration = false;
      if (WRAPPER_DURATION_RE.test(token)) continue;
      return null;
    }
    const base = token.replace(/^.*\//, "");
    if (WRAPPERS.has(base)) {
      wrapper = base;
      pendingDuration = WRAPPERS_WITH_DURATION.has(base);
      continue;
    }
    if (!wrapper) return null;
    if (token === "--") {
      wrapper = null;
      continue;
    }
    if (wrapper === "time") {
      const isOutput = token === "-o" || token === "--output" || token.startsWith("-o") && token.length > 2 ||
        token.startsWith("--output=") || (token.startsWith("-") && !token.startsWith("--") && token.slice(1).includes("o"));
      if (isOutput) {
        return token;
      }
    }
    if (wrapper === "env") {
      const option = envOption(token);
      if (option.splitPayload !== undefined) {
        const payload = option.splitPayload || tokens[i + 1];
        if (payload) {
          const nested = timeOutputOption(payload);
          if (nested) return nested;
          if (!option.attached) i++;
        }
        continue;
      }
      if (option.takesArgument) {
        if (!option.attached) i++;
        continue;
      }
    }
    if (token.startsWith("-")) {
      const optionSet = WRAPPER_OPTIONS_WITH_VALUE[wrapper];
      if (optionSet?.has(token) && i + 1 < tokens.length && !wrapperOptionHasAttachedValue(wrapper, token)) i++;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Privileged escalation heads. Never speculated on: a privileged command is
 * outside the recoverable read-only zone by definition, and detection would
 * otherwise rest entirely on the word scan matching whatever it wraps.
 */
const PRIVILEGE_HEADS = new Set(["sudo", "doas", "pkexec"]);

function findInterpreterWriter(head: string, segment: string): string | null {
  if (segment.length > MAX_LANGUAGE_ARGUMENT_LENGTH) return `${head} eval payload`;
  const payload = interpreterEvalPayload(segment);
  const language = interpreterLanguage(head);
  return scanLanguagePayload(payload, language, {
    depth: 0,
    shellBodies: new Set(),
    shellBodyCount: 0,
    classifyShell: findDestructiveTokenInternal,
  });
}

/**
 * Run the segment's READ_ONLY_HEAD_WRITES predicate, or its WRITER_HEAD_MODES
 * one, if its effective head has one.
 */
function readOnlyHeadWrite(segment: string, depth: number, followingText: string | null): string | null {
  const normalized = normalizeEnvInvocation(tokenizeShellWords(segment, ARGV));
  if (!normalized.complete || normalized.argv.length === 0) return null;
  const head = normalized.argv[0]!.replace(/^.*\//, "");
  const check = Object.hasOwn(READ_ONLY_HEAD_WRITES, head)
    ? READ_ONLY_HEAD_WRITES[head]!
    : Object.hasOwn(WRITER_HEAD_MODES, head) ? WRITER_HEAD_MODES[head]! : undefined;
  if (!check) return null;
  return check(normalized.argv.slice(1), {
    inspect: (argv) => findDestructiveTokenInternal(argv.map(shellQuoteWord).join(" "), depth + 1),
    inspectText: (text) => findDestructiveTokenInternal(text, depth + 1),
    followingText,
    assignments: normalized.assignments,
  });
}

/** A segment's effective head, with interpreter aliases mapped to their family. */
function interpreterEffectiveHead(segment: string): string | null {
  const head = effectiveHead(segment);
  return head === null ? null : interpreterFamily(head);
}

/**
 * One interpreter program (an inline `-c`/`-e` program, or a here-string or
 * heredoc it reads on stdin): its exec/spawn and writer calls, then the
 * reader allowlist. Null when every call is a known reader.
 */
function interpreterProgramToken(head: string, language: InterpolationLanguage, program: string): string | null {
  if (program.length > MAX_LANGUAGE_ARGUMENT_LENGTH) return `${head} eval payload`;
  const writer = scanLanguagePayload(program, language, {
    depth: 0,
    shellBodies: new Set(),
    shellBodyCount: 0,
    classifyShell: findDestructiveTokenInternal,
  });
  if (writer) return writer;
  const view = executableLanguageView(program, language);
  if (view === null) return `${head} eval payload`;
  const fsWriter = EVAL_WRITER_RE.exec(view);
  if (fsWriter) return fsWriter[0].trim();
  const unlisted = interpreterReaderViolation(program, language);
  if (unlisted) return `${head} eval: ${unlisted}`;
  return null;
}

/**
 * Where an interpreter's program comes from when it is not inline. A
 * here-string or heredoc on an interpreter with no inline program is that
 * program (`python3 <<< '…'`, `python3 - <<'EOF'`), classified like
 * `-c`/`-e`. Any other stdin (a pipe, a file, a compound command's redirect,
 * a caller's stdin) is a program nobody can see: an interpreter reading its
 * program from there is never read-only, and neither is text the shell
 * expands first or an interpreter with no reader allowlist (tclsh, wish,
 * expect).
 */
function stdinProgramToken(cmd: string): string | null {
  for (const { command, literals, redirected } of commandStdin(cmd)) {
    const invocation = interpreterStdinProgram(command);
    if (invocation.kind === "none") continue;
    if (redirected) return `${invocation.head} reads program from stdin`;
    if (literals.length === 0) {
      if (invocation.bare) return `${invocation.head} reads program from stdin`;
      continue;
    }
    if (invocation.kind === "unvetted") return `${invocation.head} stdin program`;
    for (const literal of literals) {
      if (literal.text === null) return `${invocation.head} stdin program`;
      if (literal.text.length > LANGUAGE_EVAL_EARLY_LIMIT) return `oversized ${invocation.head} stdin program`;
      const token = interpreterProgramToken(invocation.head, interpreterLanguage(invocation.head), literal.text);
      if (token) return token;
    }
  }
  return null;
}

/**
 * The classifier. Returns the offending token for the hard-stop message, or
 * null when the command is (heuristically) read-only.
 */
function findDestructiveTokenInternal(cmd: string, depth: number): string | null {
  if (depth >= 32) return "complex shell syntax";
  const normalized = normalizeEnvInvocation(tokenizeShellWords(cmd, ARGV));
  if (!normalized.complete) return "ambiguous env invocation";
  // Avoid sending oversized interpreter payloads through the recursive shell
  // inspection machinery. They cannot be parsed within the language-call
  // budget, so fail closed before any potentially quadratic traversal.
  const evalPreflight = interpreterEvalPreflight(cmd);
  if (evalPreflight && evalPreflight.payloadLength > LANGUAGE_EVAL_EARLY_LIMIT) {
    return "oversized interpreter eval";
  }
  const heredocHazard = heredocScanHazard(cmd);
  if (heredocHazard) return heredocHazard;
  // Here-document bodies are shell data, not separate command clauses. Keep
  // them out of every structural recursion below so a literal `>` in the body
  // cannot be mistaken for a redirect.
  const shellCommand = maskHeredocBodies(cmd);
  // Use the shared bounded traversal as a structural preflight so executable
  // control clauses and substitution bodies cannot disappear between the
  // core classifier and host policy adapters. Incomplete or over-budget shell
  // syntax is never allowed to fall through to the safe tier.
  if (!inspectCommandSubstitutionTree(shellCommand).complete) return "complex shell syntax";
  // Only the tokenizer decodes `$'...'`; the other quote walkers would end an
  // ANSI-C string at an escaped `\'` and misplace every later quote.
  if (hasAnsiCEscapedQuote(shellCommand)) return "complex shell syntax";
  const sanitized = sanitizeForRedirect(shellCommand);

  const redirect = REDIRECT_RE.exec(sanitized);
  if (redirect) return redirect[0].trim() || ">";

  const segments = splitCommandSegments(shellCommand);

  // Quoted command substitutions still execute their `$()`/backtick bodies.
  // Recurse with a finite budget so nested syntax cannot hide a mutation while
  // malformed or adversarially deep input remains bounded.
  const substitutionInspection = inspectCommandSubstitutions(shellCommand);
  if (!substitutionInspection.complete) return "complex shell syntax";
  const substitutions = substitutionInspection.bodies;
  if (substitutions.length > 0) {
    if (depth >= 32) return "complex shell syntax";
    for (const substitution of substitutions) {
      const nested = findDestructiveTokenInternal(substitution, depth + 1);
      if (nested) return nested;
    }
  }

  // A case command with no closing `esac`, or a coprocess with no executable
  // body, is not safely decomposable. Never let the generic word scan turn an
  // opaque control construct into a SAFE result.
  const trimmed = shellCommand.trim();
  if (/^case\b/.test(trimmed) && !inspectShellCommandClauses(trimmed).complete) return "complex shell syntax";
  if (/^coproc(?:\s|$)/.test(trimmed) && extractShellCommandClauses(trimmed).length === 0) {
    return "complex shell syntax";
  }

  // Parenthesized groups execute their contents even though the outer shell
  // segment starts with `(`. Inspect each group recursively, while the
  // quote-aware extractor leaves literal parentheses untouched.
  for (const group of parenthesizedBodies(shellCommand)) {
    const nested = findDestructiveTokenInternal(group, depth + 1);
    if (nested) return nested;
  }

  // Braces and control words are shell syntax, not executable heads. Inspect
  // the command clause they introduce so `{ git add; }` and `if git add; ...`
  // cannot hide the effective command. Quoted literals are not tokenized as
  // leading syntax and remain in the established safe tier.
  for (const segment of segments) {
    for (const clause of extractShellCommandClauses(segment)) {
      const nested = findDestructiveTokenInternal(clause, depth + 1);
      if (nested) return nested;
    }
  }

  // Not redundant with the per-segment pass above: segment splitting cuts a
  // `case ... esac` or function body at its inner `;;`/`;`, so only the
  // whole-command extraction sees those clauses intact; conversely, the
  // per-segment pass reaches clauses the whole-command walk leaves nested
  // (`if ! (...); then case ... esac; fi`). Removing either one changes
  // verdicts in __tests__/core/destructive-corpus.test.ts.
  for (const clause of extractShellCommandClauses(shellCommand)) {
    const nested = findDestructiveTokenInternal(clause, depth + 1);
    if (nested) return nested;
  }

  // Check output-bearing `time` options before resolving the wrapped command's
  // head. The output file is a mutation even when the inner command is a pure
  // reader such as `printf`; `-a`/`--append` only becomes relevant when paired
  // with `-o`/`--output`.
  for (const segment of segments) {
    const output = timeOutputOption(segment);
    if (output) return `time ${output}`;
  }

  // Interpreter heads are compared by family: `python3.12`/`nodejs`/`perl5.36`
  // are the interpreters every check below is keyed on.
  const heads = segments.map(interpreterEffectiveHead);

  // Privileged escalation is never speculated on, whatever it wraps.
  for (const head of heads) {
    if (head && PRIVILEGE_HEADS.has(head)) return head;
    // These shell builtins execute caller-provided command text or source a
    // file. Their static arguments are not evidence of read-only behavior;
    // this check also runs on recursively extracted -c/control/function
    // clauses, while quoted words remain data because they are not heads.
    if (head && SHELL_COMMAND_CONTROL_HEADS.has(head)) return head;
  }

  // A command name produced by expansion (`$c`, `$(printf rm)`, `/bin/r?`)
  // can be any program; nothing below can vouch for it.
  for (const segment of segments) {
    if (hasDynamicCommandName(segment)) return "dynamic command name";
  }

  // An environment variable that makes a later reader run a command
  // (LESSOPEN, NODE_OPTIONS, GIT_PAGER, ...) is as dangerous set by an earlier
  // segment (`export LESSOPEN=...; less f`) as by a command prefix, which the
  // per-head checks already see. Any segment that sets or exports one is a
  // mutation of the environment the rest of the command runs in.
  for (const segment of segments) {
    const name = commandBearingEnvironmentSetting(stripShellControlPrefix(segment));
    if (name) return name;
  }

  // Read-only heads skip the word scan, so each one's own write/exec forms
  // (`sed -n 'w F'`, `sort --output=F`, awk `print | "sh"`, `find -okdir rm`)
  // are decided here from its argv, before the safe tier can wave it through.
  // Segments are trimmed, in-order slices of shellCommand, so the text after
  // each one can be located by a forward search.
  let segmentCursor = 0;
  for (const segment of segments) {
    const at = shellCommand.indexOf(segment, segmentCursor);
    const followingText = at === -1 ? null : shellCommand.slice(at + segment.length);
    if (at !== -1) segmentCursor = at + segment.length;
    const token = readOnlyHeadWrite(stripShellControlPrefix(segment), depth, followingText);
    if (token) return token;
  }

  // Git is allowlist-oriented at the verb position. Inspect it before the
  // generic scan so read-only Git search patterns remain data, not commands.
  const gitTokens = segments.map(findGitMutationToken);
  for (const token of gitTokens) {
    if (token) return token;
  }

  // A shell's `-c` argument is executable code, not inert command data. Only
  // recurse when the effective head is an actual supported shell; quoted
  // strings passed to readers such as `echo` and `grep` never reach this path.
  const readOnlyShellSegments = new Set<number>();
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const shell = shellEvalPayload(segment);
    if (!shell) continue;
    if (shell.ambiguous) return "shell eval payload";
    if (shell.payload !== null) {
      const inheritedEnvironmentMutation = shellEnvironmentPrefixMutation(segment);
      if (inheritedEnvironmentMutation) {
        const clauses = extractShellCommandClauses(shell.payload);
        for (const clause of clauses.length > 0 ? clauses : [shell.payload]) {
          const inherited = findGitMutationToken(`${inheritedEnvironmentMutation}=1 ${clause}`);
          if (inherited) return inheritedEnvironmentMutation;
        }
      }
      const nested = findDestructiveTokenInternal(shell.payload, depth + 1);
      if (nested) return `shell ${nested}`;
      readOnlyShellSegments.add(i);
    }
  }

  // Safe tier: every head is a pure reader (its write/exec forms were already
  // stopped above), and there is no subshell content we can't attribute.
  // Word-scan skipped.
  const allSafe =
    !OPAQUE_SUBSHELL_RE.test(shellCommand) &&
    heads.every((head, i) => {
      if (readOnlyShellSegments.has(i)) return true;
      const gitReadOnly = head === "git" && gitTokens[i] === null;
      return head !== null && (READ_ONLY_HEADS.has(head) || gitReadOnly);
    });
  if (allSafe) return stdinProgramToken(cmd) ?? findTaintedEvaluation(cmd);

  const caseInspection = inspectShellCommandClauses(shellCommand);
  const wordScanSegments = /^case\b/.test(shellCommand.trim()) && caseInspection.complete && caseInspection.clauses.length > 0
    ? caseInspection.clauses
    : segments;
  const wordScanText = wordScanSegments.map((segment, i) => {
    // Control-clause prefixes are syntax, not argv data. Strip them before
    // language masking so `if command perl -eprint("unlink('x')")` resolves
    // the wrapped interpreter instead of scanning its quoted program text as
    // ordinary shell words.
    const scanSegment = stripShellControlPrefix(segment);
    return languageWordScanSegment(interpreterEffectiveHead(scanSegment) ?? heads[i] ?? "", scanSegment);
  }).join(" | ");
  const word = WORD_RE.exec(sanitizeForRedirect(wordScanText));
  if (word) return word[0].trim();

  // The scan above reads source spelling, so a writer spelled through shell
  // quoting (`r\m`, `'r'm`, `$'\x72\x6d'`, a line continuation) is invisible
  // to it. Rescan each segment's unquoted argv; interpreter and shell program
  // text stays with the language scanners below.
  const argvText = wordScanSegments.map((segment) => {
    const clause = stripShellControlPrefix(segment);
    const normalized = normalizeEnvInvocation(tokenizeShellWords(clause, ARGV));
    if (!normalized.complete || normalized.argv.length === 0) return "";
    const head = normalized.argv[0]!.replace(/^.*\//, "");
    const family = interpreterFamily(head);
    // Program text stays with the language scanners; a non-eval interpreter
    // invocation (`python3.12 setup.py install`) keeps its arguments, under
    // the canonical head the blocklist is spelled with.
    if (EVAL_SHELLS.has(head)) return head;
    if (EVAL_INTERPRETERS.has(family)) {
      return isEvalInvocation(family, clause) ? family : [family, ...normalized.argv.slice(1)].join(" ");
    }
    return [head, ...normalized.argv.slice(1)].join(" ");
  }).join(" | ");
  const argvWord = WORD_RE.exec(argvText);
  if (argvWord) return argvWord[0].trim();

  // A shell with no `-c` runs a script file or reads its commands from stdin
  // (`echo x | bash`, `bash <<< x`, `bash < f`): code we cannot see.
  for (const segment of segments) {
    if (shellEvalPayload(stripShellControlPrefix(segment))?.runsScript) return "shell script";
  }

  // Interpreter eval payloads: scan the RAW segment — writer APIs live inside
  // the quotes the sanitizer deliberately preserves words in.
  for (let i = 0; i < segments.length; i++) {
    const head = heads[i];
    if (!head) continue;
    const segment = stripShellControlPrefix(segments[i]!);
    if (EVAL_INTERPRETERS.has(head) && INPLACE_EDIT_RE.test(segment)) return "-i";
    if (isEvalInvocation(head, segment)) {
      const languageWriter = findInterpreterWriter(head, segment);
      if (languageWriter) return languageWriter;
      const writerPayload = interpreterEvalPayload(segment);
      const language = interpreterLanguage(head);
      const writerSource = executableLanguageView(writerPayload, language);
      if (writerSource === null) return `${head} eval payload`;
      const writer = EVAL_WRITER_RE.exec(writerSource);
      if (writer) return writer[0].trim();
    }
    // The allowlist runs on programs extracted with the interpreter's own
    // option grammar, independent of isEvalInvocation's spellings (`perl -E`,
    // `python3 -Ic`, `node --eval=`), and re-runs the writer screens on them.
    if (EVAL_INTERPRETERS.has(head)) {
      const extracted = interpreterEvalPrograms(segment);
      if (extracted.kind === "violation") return `${head} eval: ${extracted.reason}`;
      if (extracted.kind === "eval") {
        const language = interpreterLanguage(head);
        const programs = extracted.join ? [extracted.programs.join("\n")] : extracted.programs;
        for (const program of programs) {
          const token = interpreterProgramToken(head, language, program);
          if (token) return token;
        }
      }
    }
  }

  // Last, so it only turns a read-only verdict into a stop: an arithmetic
  // context or variable name that evaluates a data-derived value can run a
  // command substitution.
  // It reads the unmasked command: an unquoted heredoc body expands `$((…))`.
  // So does the stdin check: a heredoc body is exactly what it judges.
  return stdinProgramToken(cmd) ?? findTaintedEvaluation(cmd);
}

/**
 * The classifier's public entry. Input past MAX_COMMAND_LENGTH, or with one
 * whitespace-free run past MAX_CLASSIFY_WORD_LENGTH, is mutating without a
 * scan: the evaluator must terminate promptly on any input.
 */
export function findDestructiveToken(cmd: string): string | null {
  if (cmd.length > MAX_COMMAND_LENGTH) return "oversized command";
  if (longestWordLength(cmd) > MAX_CLASSIFY_WORD_LENGTH) return "oversized shell word";
  const masked = findDestructiveTokenInternal(cmd, 0);
  if (masked) return masked;
  // Second pass with no heredoc masking (R18): every physical line is
  // command text, for every stage including the stdin-program checks.
  // Masking decides what is data, and each scanner miss there (a here-string,
  // an arithmetic shift, a comment, quoted arithmetic, a backtick heredoc)
  // used to hide the next line; now a line the first pass took for heredoc
  // body is still classified here.
  return withoutHeredocMasking(() => findDestructiveTokenInternal(cmd, 0));
}

export function isDestructiveCommand(cmd: string): boolean {
  return findDestructiveToken(cmd) !== null;
}
