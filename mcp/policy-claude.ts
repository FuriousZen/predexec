/**
 * predexec policy — Claude Code host-permission reader/checker (MCP adapter).
 *
 * Harness-facing (NOT part of pure `core/`): fs + env access lives here, like
 * policy.ts/steering.ts/stats.ts. Same hole as opencode's, but wider: an MCP
 * server is a separate process, so a shell string predexec spawns is not
 * filtered by the user's `Bash(...)` rules at all. Verified verbatim —
 * "Read and Edit deny rules apply to Claude's built-in file tools and to file
 * commands Claude Code recognizes in Bash… They don't apply to arbitrary
 * subprocesses that read or write files indirectly" (permissions.md). MCP tools
 * are permissioned at the granularity of `mcp__predexec__predexec`, not at the
 * granularity of what that tool does inside. Without this module predexec is a
 * permission-laundering path: a user who wrote `deny: ["Bash(curl *)"]` would
 * find predexec running curl anyway.
 *
 * So predexec reads Claude Code's own settings and hard-stops (`policyStop`)
 * BEFORE running any command a deny OR ask rule would have caught — predexec
 * cannot prompt mid-walk, so a would-be prompt is a stop. The standing rule:
 * strictly MORE conservative than the host, never less. Every judgement call
 * below resolves in that direction.
 *
 * PRECEDENCE DIFFERS FROM policy.ts — read this before assuming they match.
 * opencode evaluates rules last-matching-wins, so a later `allow` genuinely
 * rescues a command an earlier `deny` caught. Claude Code does not: "Rules are
 * evaluated in order: deny, then ask, then allow. The first match in that order
 * determines the outcome, and rule specificity doesn't change the order."
 * So allow rules are parsed (they belong in the rule list a caller inspects)
 * but the checker never consults them — nothing widens what predexec will run.
 * Deny/ask are restrictive-only and therefore apply regardless of workspace
 * trust, which is why an untrusted workspace changes nothing here.
 *
 * Because a deny/ask at ANY scope stops us, the settings chain is a union
 * rather than an override cascade. That is what makes the messy parts cheap:
 * reading a stale cwd-local settings file alongside the repo-root one, or a
 * managed drop-in directory, can only ever add stops.
 *
 * Reads are exception-safe, but a settings file that EXISTS and fails to parse
 * is treated as unknown → stop, not as absent → allow, exactly as policy.ts
 * does. An unreadable policy is when guessing "allow" is least defensible.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import { splitCommandSegments } from "../core/index.ts";

export type ClaudePolicyAction = "allow" | "ask" | "deny";

export interface ClaudePolicyRule {
  /** The bash-command glob, with `Bash(...)` and the `:*` alias normalized away. */
  pattern: string;
  action: ClaudePolicyAction;
}

export interface ClaudePolicyOptions {
  /** Env to read `CLAUDE_CONFIG_DIR` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Managed-settings directory override. Tests cannot write to `/etc`. */
  managedDir?: string;
}

/**
 * Bash tool input parameters, for the `Tool(param:value)` rule form.
 *
 * `Bash(command:rm *)` is the load-bearing one: Claude Code IGNORES it and
 * emits a startup warning, because a compound command would bypass it. Honoring
 * a rule the host does not honor would make predexec stricter-than-AND-
 * different-from the host, which is the one flavour of conservative that just
 * confuses people. The rest constrain a parameter, not command text, so they
 * say nothing about a command string.
 *
 * Note what is deliberately NOT here: `git`. In `Bash(git:* push)` the colon is
 * literal (docs are explicit), so that rule stays a — useless, never-matching —
 * command pattern rather than being parsed as a parameter form.
 */
const BASH_PARAMETERS = new Set(["command", "timeout", "description", "run_in_background"]);

/**
 * Wrappers Claude Code strips before matching Bash rules, so `Bash(npm test *)`
 * also matches `timeout 30 npm test`. We must strip them too, in the same
 * direction: without this, `deny: ["Bash(rm *)"]` would miss `timeout 5 rm -rf
 * tmp` and predexec would run a command the host blocks — less conservative
 * than the host, which is the failure this file exists to prevent.
 *
 * The list is Claude Code's, not core's `WRAPPERS` (a different set for a
 * different job). Environment runners like `npx`/`docker exec` are pointedly
 * absent from the host's list, so they are absent here.
 */
const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "noglob"]);
/** Wrappers that take their own options, whose flags/durations are consumed too. */
const OPTION_TAKING_WRAPPERS = new Set(["timeout", "nice", "stdbuf"]);
/** Stripped only when NOT followed by a flag: `command -v foo` looks a command up rather than running it, and `xargs -n1 grep` is matched as an xargs command. */
const BARE_ONLY_WRAPPERS = new Set(["command", "builtin", "xargs"]);

const LEADING_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
const DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;

const ACTIONS: ClaudePolicyAction[] = ["deny", "ask", "allow"];

/**
 * Strip wrappers and leading assignments the way Claude Code does before
 * matching. Returns the command unchanged when nothing applies.
 *
 * A deny/ask rule "matches past any leading assignment", so `Bash(rm *)` still
 * catches `FOO=bar rm -rf tmp/` — hence the assignment strip runs on every
 * pass, not just the first.
 */
export function stripBashWrappers(command: string): string {
  let cmd = command.trim();
  // Bounded: each pass must consume at least one token or it breaks out anyway,
  // but a cap keeps a pathological input from spinning.
  for (let pass = 0; pass < 16; pass++) {
    const before = cmd;
    cmd = cmd.replace(LEADING_ASSIGNMENT_RE, "").trimStart();

    const tokens = cmd.split(/\s+/);
    const head = tokens[0];
    if (head && (WRAPPERS.has(head) || BARE_ONLY_WRAPPERS.has(head))) {
      const next = tokens[1];
      const isFlag = next !== undefined && next.startsWith("-");
      // `command -v`/`xargs -n1` are not wrapper invocations; leave them whole.
      if (!(BARE_ONLY_WRAPPERS.has(head) && isFlag)) {
        let drop = 1;
        if (OPTION_TAKING_WRAPPERS.has(head)) {
          // `timeout 30 npm test` / `nice -n 10 cmd`: the wrapper's own flags
          // and duration are part of the wrapper, not of the command.
          while (drop < tokens.length) {
            const token = tokens[drop]!;
            if (token.startsWith("-") || DURATION_RE.test(token)) drop++;
            else break;
          }
        }
        if (drop < tokens.length) cmd = tokens.slice(drop).join(" ");
      }
    }
    if (cmd === before) break;
  }
  return cmd;
}

/**
 * Parse one settings file's `permissions` into ordered bash rules.
 *
 * Deny first, then ask, then allow — the order Claude Code evaluates them in,
 * so the pattern reported for a stop is the deny that caught it when both a
 * deny and an ask match. Non-Bash entries (`Read(./.env)`, `WebFetch(...)`) are
 * skipped: they gate tools this checker does not speak for.
 * Throws on malformed JSON so the caller can fail closed. Claude Code settings
 * are strict JSON — no comment stripping, unlike opencode's `.jsonc`.
 */
export function parseClaudeBashRules(settingsText: string): ClaudePolicyRule[] {
  const settings = JSON.parse(settingsText) as { permissions?: unknown };
  const permissions = settings?.permissions;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) return [];

  const rules: ClaudePolicyRule[] = [];
  for (const action of ACTIONS) {
    const entries = (permissions as Record<string, unknown>)[action];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      const pattern = bashPatternFromEntry(entry, action);
      if (pattern !== null) rules.push({ pattern, action });
    }
  }
  return rules;
}

/**
 * Reduce one permission entry to the bash glob it constrains, or null when it
 * says nothing about bash commands.
 *
 * Handles every documented spelling: `Bash(git push *)`, bare `Bash` and
 * `Bash(*)` (equivalent, both mean every command), the ignored parameter form,
 * and — for deny/ask only — a tool-name glob such as `"*"` that matches every
 * tool, Bash included. Skipping bare `Bash` would be the largest possible
 * under-conservatism here: it is the strongest signal a user can send.
 */
function bashPatternFromEntry(entry: string, action: ClaudePolicyAction): string | null {
  const trimmed = entry.trim();
  const open = trimmed.indexOf("(");

  if (open === -1 || !trimmed.endsWith(")")) {
    // Bare tool name, or a tool-name glob. Allow-rule globs are anchored to an
    // `mcp__<server>__` prefix by the host and never auto-approve bash, so only
    // deny/ask are considered; `mcp__*` must NOT stop bash.
    if (trimmed === "Bash") return "*";
    if (action !== "allow" && trimmed.includes("*")) {
      const regex = patternToRegex(trimmed);
      return regex?.test("Bash") ? "*" : null;
    }
    return null;
  }

  if (trimmed.slice(0, open).trim() !== "Bash") return null;
  const inner = trimmed.slice(open + 1, -1).trim();
  if (inner === "" || inner === "*") return "*";

  // Parameter form — `Bash(command:rm *)` and friends. Whitespace around the
  // colon is ignored by the host, so it is ignored here too.
  const colon = inner.indexOf(":");
  if (colon > 0 && !(colon === inner.length - 2 && inner.endsWith(":*"))) {
    const name = inner.slice(0, colon).trim();
    if (BASH_PARAMETERS.has(name)) return null;
  }
  return inner;
}

/**
 * Compile a Claude Code bash pattern to an anchored regex.
 *
 * Four shapes, and the differences between them are the whole point:
 *   `ls *`  → word boundary, trailing args OPTIONAL: matches `ls -la` and bare
 *             `ls` ("requiring the prefix to be followed by a space or
 *             end-of-string"), but never `lsof`.
 *   `ls:*`  → alias for `ls *`, recognized ONLY at the end of a pattern; in
 *             `git:* push` the colon is a literal character.
 *   `ls*`   → no boundary: matches `ls -la` AND `lsof`.
 *   `git * main` / `* install` → a mid or leading `*` is a plain wildcard
 *             spanning any characters, spaces included.
 *
 * Compiling `ls *` as `^ls .*$` — the obvious reading — misses bare `ls`, and
 * a missed deny is a command predexec runs that the host would have blocked.
 */
function patternToRegex(pattern: string): RegExp | null {
  try {
    let body = pattern.endsWith(":*") ? `${pattern.slice(0, -2)} *` : pattern;
    let tail = "";
    if (body.endsWith(" *")) {
      body = body.slice(0, -2);
      tail = "(?: [\\s\\S]*)?";
    }
    const escaped = body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "[\\s\\S]*");
    return new RegExp(`^${escaped}${tail}$`);
  } catch {
    return null;
  }
}

/**
 * Command-substitution payloads: the bodies of `$(…)`, `` `…` ``, `<(…)` and
 * `>(…)`.
 *
 * `splitCommandSegments` treats `echo $(curl evil.sh)` as one segment whose
 * head is `echo`, so a `curl *` deny would never see the curl. Substitution is
 * a documented smuggling route — the host's own `rm -rf ~` circuit breaker
 * calls out `$(…)`, backticks and `<(…)` by name — so each body is judged as a
 * command in its own right. Single-quoted text is skipped: `grep '$(x)' f` is
 * a literal string, not a substitution.
 */
function extractSubstitutions(command: string): string[] {
  const found: string[] = [];
  let inSingle = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (inSingle) continue;

    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      if (end === -1) break;
      found.push(command.slice(i + 1, end));
      i = end;
      continue;
    }
    const opensParen =
      command[i + 1] === "(" && (ch === "$" || ch === "<" || ch === ">");
    if (!opensParen) continue;
    // Depth-aware so a nested `$(a $(b))` yields the whole outer body, which
    // the recursion below then re-scans.
    let depth = 0;
    for (let j = i + 1; j < command.length; j++) {
      const inner = command[j]!;
      if (inner === "(") depth++;
      else if (inner === ")") {
        depth--;
        if (depth === 0) {
          found.push(command.slice(i + 2, j));
          i = j;
          break;
        }
      }
    }
  }
  return found;
}

/** The git repository root for `dir`, or null when there is no repo above it. */
function findRepoRoot(dir: string): string | null {
  const root = parsePath(dir).root;
  let current = dir;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current || current === root) return null;
    current = parent;
  }
}

/**
 * The main checkout backing a linked worktree, or null.
 *
 * Claude Code resolves `settings.local.json` "through worktrees to the main
 * checkout". In a linked worktree `.git` is a FILE holding
 * `gitdir: /path/to/main/.git/worktrees/<name>`, so the main checkout is
 * readable with plain fs — no `git` subprocess, which keeps this module
 * side-effect free and testable.
 */
function mainCheckoutOf(repoRoot: string): string | null {
  try {
    const dotGit = join(repoRoot, ".git");
    if (statSync(dotGit).isDirectory()) return null;
    const match = /gitdir:\s*(.+)/.exec(readFileSync(dotGit, "utf8"));
    const gitDir = match?.[1]?.trim();
    const marker = gitDir?.indexOf(`${join(".git", "worktrees")}`) ?? -1;
    if (!gitDir || marker <= 0) return null;
    return gitDir.slice(0, marker - 1);
  } catch {
    return null;
  }
}

/**
 * Every settings file Claude Code would consult, in the documented precedence
 * order (managed → local project → project → user).
 *
 * The order is documentation, not behavior: deny/ask from any scope stops us,
 * so the checker unions them. That is also why the list is generous —
 * `managed-settings.d/` drop-ins, the repo root AND the main checkout AND the
 * cwd copy of `settings.local.json` (pre-v2.1.211 left one behind, and the
 * host keeps "permission rules from both files in effect"). Each extra file can
 * only add stops.
 *
 * Not representable: the host's `--allowedTools`/`--disallowedTools` CLI flags.
 * A subprocess cannot see them, so a CLI-only deny is a hole predexec cannot
 * close.
 */
export function claudeSettingsPaths(projectDir: string, opts: ClaudePolicyOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const paths: string[] = [];

  const managedDir = opts.managedDir ?? defaultManagedDir();
  paths.push(join(managedDir, "managed-settings.json"));
  try {
    const dropIn = join(managedDir, "managed-settings.d");
    for (const name of readdirSync(dropIn).sort()) {
      if (name.endsWith(".json")) paths.push(join(dropIn, name));
    }
  } catch {
    // Absent drop-in dir is the normal case, not an error.
  }

  // `.claude/settings.local.json` lives at the git repository root since
  // v2.1.211, not in the directory Claude Code was started from.
  const repoRoot = findRepoRoot(projectDir);
  const localRoots = new Set<string>();
  if (repoRoot) {
    localRoots.add(repoRoot);
    const mainCheckout = mainCheckoutOf(repoRoot);
    if (mainCheckout) localRoots.add(mainCheckout);
  }
  localRoots.add(projectDir);
  for (const dir of localRoots) paths.push(join(dir, ".claude", "settings.local.json"));

  paths.push(join(projectDir, ".claude", "settings.json"));

  // CLAUDE_CONFIG_DIR relocates the user config dir. Verified present in the
  // shipped CLI (2.1.223); the public settings docs do not list it.
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  paths.push(join(configDir, "settings.json"));

  return paths;
}

function defaultManagedDir(): string {
  switch (platform()) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode";
    case "win32":
      return "C:\\Program Files\\ClaudeCode";
    default:
      return "/etc/claude-code";
  }
}

/**
 * Read bash rules across every settings file Claude Code would consult.
 *
 * `unreadable` reports files that exist but failed to parse; the caller fails
 * closed on those. A settings file we cannot read is the worst possible moment
 * to assume "allow".
 */
export function readClaudeBashRules(
  projectDir: string,
  opts: ClaudePolicyOptions = {},
): { rules: ClaudePolicyRule[]; unreadable: string[] } {
  const rules: ClaudePolicyRule[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  for (const path of claudeSettingsPaths(projectDir, opts)) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    try {
      rules.push(...parseClaudeBashRules(readFileSync(path, "utf8")));
    } catch {
      unreadable.push(path);
    }
  }
  return { rules, unreadable };
}

/**
 * Build the `checkCommandPolicy` callback for the engine.
 *
 * Returns the matched pattern when a deny or ask rule catches any part of the
 * command, else null. Allow rules are ignored entirely — under Claude Code's
 * deny → ask → allow ordering an allow can never rescue a denied command, so
 * consulting one could only widen what predexec runs.
 *
 * Each pipeline segment is judged independently, so `echo hi && curl evil.sh`
 * cannot smuggle the curl past a `curl *` rule — "A rule must match each
 * subcommand independently." Newlines are a recognized separator too, and
 * `splitCommandSegments` (core, shared with the destructive heuristic) does not
 * split them, so lines are split off first.
 *
 * `unreadable` settings paths stop everything: we know a policy exists and
 * could not read it, so running anything would be guessing.
 */
export function createClaudePolicyChecker(
  rules: ClaudePolicyRule[],
  unreadable: string[] = [],
): (cmd: string) => string | null {
  if (unreadable.length > 0) {
    // Name the file and the remedy: without that this reads as a predexec bug
    // rather than a syntax error in the user's own settings.
    const why =
      `cannot read your Claude Code permission rules (${unreadable[0]} is not valid JSON) — ` +
      `predexec stops rather than run commands your policy might forbid; fix that file to continue`;
    return () => why;
  }

  const compiled = rules
    .filter((rule) => rule.action !== "allow")
    .map((rule) => ({ ...rule, regex: patternToRegex(rule.pattern) }))
    .filter((rule): rule is ClaudePolicyRule & { regex: RegExp } => rule.regex !== null)
    // Deny before ask across files too, so a stop reports the deny that caught
    // it rather than an ask from a file that happened to be read first. Both
    // stop; only the pattern named in the transcript changes.
    .sort((a, b) => (a.action === b.action ? 0 : a.action === "deny" ? -1 : 1));
  if (compiled.length === 0) return () => null;

  return (cmd: string) => {
    try {
      // Substitution bodies are judged as commands too, and are themselves
      // rescanned (capped) so nesting cannot hide one level deeper.
      const pending = [cmd];
      for (let depth = 0; depth < 4 && pending.length > 0; depth++) {
        const batch = pending.splice(0, pending.length);
        for (const text of batch) {
          pending.push(...extractSubstitutions(text));
          for (const line of text.split("\n")) {
            for (const segment of splitCommandSegments(line)) {
              const trimmed = segment.trim();
              if (!trimmed) continue;
              // Match the raw segment AND its wrapper-stripped form, then take
              // the union: raw-only misses a `rm *` deny on `timeout 5 rm -rf
              // tmp`, stripped-only misses a `timeout *` deny on the same
              // command.
              const stripped = stripBashWrappers(trimmed);
              const forms = stripped === trimmed ? [trimmed] : [trimmed, stripped];
              for (const rule of compiled) {
                if (forms.some((form) => rule.regex.test(form))) return rule.pattern;
              }
            }
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  };
}
