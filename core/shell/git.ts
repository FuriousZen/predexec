/**
 * Git classification for the destructive-command heuristic (core/destructive.ts).
 *
 * Git is allowlist-oriented at the verb position: read-only verbs and
 * subforms pass, everything else is a mutation. Global options, `-c`/
 * `--config-env` config keys, and prefix environment variables that make a
 * read-only invocation run a caller-controlled program are classified here too.
 */

import {
  ARGV,
  ENV_ASSIGNMENT_RE,
  normalizeEnvInvocation,
  tokenizeShellWords,
} from "./lexer.ts";

/** Git verbs whose ordinary invocation is read-only. */
const READ_ONLY_GIT_VERBS = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree",
  "grep", "blame", "describe", "shortlog", "name-rev", "for-each-ref",
]);

/** Git global options which consume the following argument as their value. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env",
]);

/** Git global options which do not consume an additional argument. */
const GIT_GLOBAL_OPTIONS = new Set([
  "-p", "-P", "--paginate", "--no-pager", "--no-replace-objects", "--no-lazy-fetch",
  "--no-optional-locks", "--no-advice", "--no-sparse", "--literal-pathspecs",
  "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--exec-path",
  "--html-path", "--man-path", "--info-path", "--version", "--help",
]);

/** Git global options that are themselves read-only queries when no verb follows. */
const GIT_READ_ONLY_GLOBAL_OPTIONS = new Set([
  "--exec-path", "--html-path", "--man-path", "--info-path", "--version", "--help",
]);

/** Git configuration keys whose values can invoke a process while reading. */
const GIT_COMMAND_CONFIG_KEY_RE = /^(?:core\.pager(?:\..*)?|pager(?:\..*)?|core\.fsmonitor|diff\..*(?:external|textconv)|diff\..+\.command|filter(?:\..*)?|core\.(?:sshcommand|gitproxy)|credential\.helper(?:\..*)?)$/i;

/**
 * Environment variables that can make an otherwise read-only Git invocation
 * execute caller-controlled programs. Git reads these before dispatching the
 * verb, so they belong to the invocation prefix rather than the argument
 * data. Config-file selectors are included because the selected config can
 * install any of the command-bearing settings above.
 */
const GIT_COMMAND_ENV_NAME_RE = new RegExp(
  "^(?:GIT_EXTERNAL_DIFF|GIT_CONFIG(?:_PARAMETERS|_(?:GLOBAL|SYSTEM))?|" +
  "GIT_CONFIG_(?:COUNT|KEY_|VALUE_)[A-Za-z0-9_]*|(?:GIT_)?PAGER|" +
  "GIT_(?:SSH|SSH_COMMAND|EDITOR|SEQUENCE_EDITOR|ASKPASS|PROXY_COMMAND|EXEC_PATH|DIFF_TOOL|MERGE_TOOL))$",
  "i",
);

/**
 * Inspect only the prefix that launches Git. Assignment-looking text in Git
 * arguments (especially after `--`) is data and must not trigger this check.
 * Assignments are supplied by the bounded env normalizer, including nested
 * `env`/`command` forms.
 */
export function gitEnvironmentPrefixMutation(assignments: string[]): string | null {
  for (const token of assignments) {
    const assignment = ENV_ASSIGNMENT_RE.exec(token);
    if (!assignment) continue;
    const name = assignment[1]!;
    if (GIT_COMMAND_ENV_NAME_RE.test(name)) return name;
    if (name.startsWith("GIT_CONFIG_KEY_") || name.startsWith("GIT_CONFIG_VALUE_")) return name;
  }
  return null;
}

function gitReadOnlySubformOption(
  token: string,
  allowed: Set<string>,
  valueOptions: Set<string>,
): { known: boolean; consumesNext: boolean } {
  if (!token.startsWith("-")) return { known: true, consumesNext: false };
  const equals = token.indexOf("=");
  const name = equals < 0 ? token : token.slice(0, equals);
  if (!allowed.has(name)) return { known: false, consumesNext: false };
  return { known: true, consumesNext: equals < 0 && valueOptions.has(name) };
}

/**
 * Read-only Git subforms are argv grammars, not prefixes. A later action or
 * option must invalidate the allowlist; after `--`, every token is data.
 * Unknown options fail closed because this intentionally covers only the
 * narrow display/query forms used by the classifier.
 */
function isGitReadOnlySubform(tokens: string[], verbIndex: number): boolean {
  const verb = tokens[verbIndex];
  const subform = tokens[verbIndex + 1];
  let allowed: Set<string>;
  let values: Set<string>;
  let bareActions: Set<string>;
  if (verb === "branch" && (subform === "-l" || subform === "--list" || subform === "-v" || subform === "-vv")) {
    allowed = new Set(["-l", "--list", "-v", "-vv", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--column", "--no-column", "--color", "--no-color"]);
    values = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--color"]);
    bareActions = new Set();
  } else if (verb === "tag" && (subform === "-l" || subform === "--list")) {
    allowed = new Set(["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--column", "--no-column", "--color", "--no-color"]);
    values = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--color"]);
    bareActions = new Set();
  } else if (verb === "stash" && (subform === "list" || subform === "show")) {
    allowed = new Set(["list", "show", "-p", "--patch", "--stat", "--summary", "--name-only", "--name-status", "--oneline", "--format", "--pretty", "--include-untracked", "--no-include-untracked"]);
    values = new Set(["--format", "--pretty"]);
    bareActions = new Set(["drop", "pop", "apply", "clear", "branch", "push", "create", "store"]);
  } else if (verb === "config" && (subform === "--get" || subform?.startsWith("--get-") || subform === "--list" || subform === "-l")) {
    allowed = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--show-origin", "--show-scope", "--show-names", "--name-only", "--includes", "--null", "--fixed-value", "--type", "--default", "--local", "--global", "--system", "--file", "--blob"]);
    values = new Set(["--type", "--default", "--file", "--blob"]);
    bareActions = new Set();
  } else if (verb === "remote" && (subform === "-v" || subform === "show")) {
    allowed = new Set(["-v", "show", "-n", "--no-query", "--get-url"]);
    values = new Set();
    bareActions = new Set(["add", "remove", "rename", "set-head", "set-branches", "set-url", "prune", "update"]);
  } else {
    return false;
  }

  for (let i = verbIndex + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") return true;
    if (!token.startsWith("-")) {
      if (bareActions.has(token)) return false;
      continue;
    }
    const parsed = gitReadOnlySubformOption(token, allowed, values);
    if (!parsed.known) {
      return false;
    }
    if (parsed.consumesNext) {
      if (i + 1 >= tokens.length || tokens[i + 1] === "--" || tokens[i + 1]!.startsWith("-")) return false;
      i++;
    }
  }
  return true;
}

function gitConfigOptionMutation(tokens: string[], index: number): { token: string | null; consumed: number } {
  const option = tokens[index]!;
  const separate = option === "-c" || option === "--config-env";
  const raw = separate ? tokens[index + 1] : option.startsWith("-c") ? option.slice(2) : option.startsWith("--config-env=") ? option.slice("--config-env=".length) : null;
  if (!raw || !raw.includes("=")) return { token: option, consumed: separate ? 1 : 0 };
  const key = raw.split("=", 1)[0]!.trim();
  // A dynamic or malformed key could resolve to a command-bearing setting;
  // only the ordinary static Git key alphabet is safe to inspect further.
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(key) || GIT_COMMAND_CONFIG_KEY_RE.test(key)) {
    return { token: option, consumed: separate ? 1 : 0 };
  }
  return { token: null, consumed: separate ? 1 : 0 };
}

function gitReadOnlyOptionMutation(tokens: string[], start: number, verb: string): string | null {
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") return null;
    // R60 (C4): `git grep -O[cmd]` (attached or clustered) opens the matches
    // in a pager, like --open-files-in-pager. On log/diff `-O` is an orderfile.
    if (verb === "grep" && /^-[^-]*O/.test(token)) return token;
    if (token === "--ext-diff" || token === "--textconv" || token === "--paginate" || token === "-p" ||
      /^--open-files-in-pager(?:=|$)/.test(token) || /^--output(?:=|$)/.test(token) || /^-[^-]*o(?:.|$)/.test(token)) {
      return token;
    }
    if (token === "--no-ext-diff" || token === "--no-textconv") continue;
  }
  return null;
}

/**
 * Return a mutation token for a Git segment whose verb is not allowlisted, or
 * null for an established read-only verb/subform. Global options are skipped
 * only in this verb position; their values are never treated as commands.
 */
export function findGitMutationToken(segment: string): string | null {
  const tokens = tokenizeShellWords(segment, ARGV);
  const normalized = normalizeEnvInvocation(tokens);
  if (!normalized.complete) return "ambiguous env invocation";
  if (normalized.argv.length === 0) return null;
  const gitIndex = 0;
  if (normalized.argv[gitIndex]!.replace(/^.*\//, "") !== "git") return null;
  const environmentMutation = gitEnvironmentPrefixMutation(normalized.assignments);
  if (environmentMutation) return environmentMutation;

  let verbIndex = gitIndex + 1;
  let readOnlyGlobalQuery = false;
  while (verbIndex < normalized.argv.length) {
    const option = normalized.argv[verbIndex]!;
    if (option === "--") {
      verbIndex++;
      break;
    }
    if (option === "-p" || option === "--paginate") return `git ${option}`;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
      if (option === "-c" || option === "--config-env") {
        const config = gitConfigOptionMutation(normalized.argv, verbIndex);
        if (config.token) return `git ${config.token}`;
        verbIndex += 2;
      } else {
        verbIndex += 2;
      }
      continue;
    }
    if (option.startsWith("--config-env=") || (option.startsWith("-c") && option.length > 2)) {
      const config = gitConfigOptionMutation(normalized.argv, verbIndex);
      if (config.token) return `git ${config.token}`;
      verbIndex++;
      continue;
    }
    if (
      option.startsWith("--git-dir=") ||
      option.startsWith("--work-tree=") ||
      option.startsWith("--namespace=") ||
      option.startsWith("--super-prefix=") ||
      (option.startsWith("-C") && option.length > 2)
    ) {
      verbIndex++;
      continue;
    }
    if (option.startsWith("--exec-path=")) {
      // R66 (M1): a verb after it runs with sub-programs from that directory.
      if (verbIndex + 1 < normalized.argv.length) return `git ${option}`;
      readOnlyGlobalQuery = true;
      verbIndex++;
      continue;
    }
    if (option === "--exec-path") {
      readOnlyGlobalQuery = true;
      const value = normalized.argv[verbIndex + 1];
      // Git's exec-path argument is optional. Consume only an unmistakable
      // path so a mutating-looking token such as `add` cannot disappear as a
      // purported option value.
      if (value && /^(?:~|\.{0,2}\/|\/)/.test(value)) verbIndex += 2;
      else verbIndex++;
      continue;
    }
    if (GIT_GLOBAL_OPTIONS.has(option)) {
      if (GIT_READ_ONLY_GLOBAL_OPTIONS.has(option)) readOnlyGlobalQuery = true;
      verbIndex++;
      continue;
    }
    break;
  }

  const verb = normalized.argv[verbIndex];
  if (!verb) return readOnlyGlobalQuery ? null : "git";
  if (READ_ONLY_GIT_VERBS.has(verb)) {
    const optionMutation = gitReadOnlyOptionMutation(normalized.argv, verbIndex + 1, verb);
    return optionMutation ? `git ${optionMutation}` : null;
  }
  if (isGitReadOnlySubform(normalized.argv, verbIndex)) return null;
  return `git ${verb}`;
}
