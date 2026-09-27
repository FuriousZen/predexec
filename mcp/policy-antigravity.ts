/**
 * predexec policy — Antigravity CLI (`agy`) grant reader/checker (MCP adapter).
 *
 * Harness-facing (NOT part of pure `core/`): fs + env access lives here, like
 * policy-claude.ts / policy-codex.ts. Load-bearing for the same reason as the
 * Codex reader: agy spawns MCP servers from its language server OUTSIDE its
 * terminal sandbox, even with `--sandbox` (measured, docs/research/antigravity.md
 * §c), so predexec's read-only invariant + destructive.ts + this module are the
 * only containment a plan has under agy.
 *
 * Source: `~/.gemini/antigravity-cli/settings.json` — `permissions.{deny,ask,allow}`,
 * `toolPermission`, `allowNonWorkspaceAccess`. Semantics follow
 * https://antigravity.google/docs/permissions:
 *
 *  - Grants are `action(target)`. `command(prefix)` prefix-matches by word/token
 *    (`command(git)` matches `git status`, never `gitk`); `command(regex:p)`
 *    evaluates each whitespace-separated token of `p` as an anchored
 *    `^(?:tok)$` against the corresponding command token; `(*)` matches all.
 *    `read_file(path)` matches an absolute or workspace-relative path and
 *    covers everything below it.
 *  - Precedence is strictly Deny > Ask > Allow. A deny OR ask match is a
 *    `policyStop`: predexec cannot prompt mid-walk.
 *  - Commands using command/process substitution (`$(`, backticks, `<(`/`>(`)
 *    or brace expansion disable prefix matching in agy — only an exact
 *    full-line grant matches them. predexec applies that to ALLOW grants only;
 *    deny/ask grants keep prefix-matching (and also see inside substitution
 *    bodies), because over-stopping is the safe direction.
 *  - Transparent wrappers (`timeout`/`nohup`/`nice`/`env`) and pipelines /
 *    `&&`/`||`/`;` chains still prefix-match: each segment is judged.
 *  - `toolPermission: "strict"` → every operation needs a matching allow.
 *    Known values (from the agy binary): `always-proceed`, `request-review`
 *    (default), `strict`; an UNKNOWN value is treated as strict (fail closed).
 *  - `allowNonWorkspaceAccess: false` → a tool op whose path resolves outside
 *    the workspace stops.
 *
 * Fail-closed contract (same as policy.ts / policy-codex.ts): a missing file
 * is "no rules"; a file that exists but will not parse, or has the wrong
 * shape, stops EVERY operation. An unknown grant syntax — or an unsafe
 * `regex:` (isSafeRegex) — in deny/ask stops every operation that grant's
 * action could cover (all shell commands for `command`, all tool ops and
 * every shell command naming a path operand for `read_file`, everything for
 * an unknown action). `read_file` deny/ask also applies to the path operands
 * of every shell command, whatever its head (see checkShellPaths). Unknown syntax in allow is
 * ignored: dropping an allow can only add stops.
 *
 * Grants for actions predexec never performs (`write_file`, `read_url`,
 * `execute_url`, `mcp`, Windows' `unsandboxed`) are recognized and ignored —
 * except that a `write_file` ALLOW implies `read_file` for the same target,
 * per the docs.
 *
 * Known gaps: grants made in the app/IDE UI or per-project grants under
 * `~/.gemini/config/projects/` are not read; agy's other exact-match
 * triggers (non-literal command names, fd/network redirections, `git -c`-style subcommand flags) are not modelled.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  commandsWithUnresolvableOperands,
  describeUnresolvableOperand,
  inspectCommandSubstitutionTree,
  isSafeRegex,
  operandHeadMayReadPaths,
  ruleHeadCouldMatch,
  splitCommandSegments,
  stripLeadingAssignmentsAndWrappers,
  tokenizeShellWords,
  type Operation,
  type OperationPolicyChecker,
  type PolicyCheckContext,
  type PolicyVerdict,
  type WrapperInspectionOptions,
} from "../core/index.ts";
import { resolveShellPathOperands } from "./policy-claude.ts";

export interface AntigravityGrant {
  action: string;
  target: { kind: "prefix" | "regex" | "any"; value: string };
}

export interface AntigravityPolicyOptions {
  /** Home dir holding `.gemini/`. Defaults to `env.HOME`, then `os.homedir()`. Tests use this. */
  home?: string;
  /** agy's workspace dir: relative `read_file` grants and `allowNonWorkspaceAccess` resolve against it. */
  cwd: string;
  /** Env to read `HOME` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const GRANT_RE = /^([a-z_]+)\(([\s\S]+)\)$/;

/** Parse one `action(target)` grant string; null when it is not that shape. */
export function parseAntigravityGrant(s: string): AntigravityGrant | null {
  if (typeof s !== "string") return null;
  const m = GRANT_RE.exec(s.trim());
  if (!m) return null;
  const action = m[1]!;
  const value = m[2]!.trim();
  if (!value) return null;
  if (value === "*") return { action, target: { kind: "any", value } };
  if (value.startsWith("regex:")) {
    const pattern = value.slice("regex:".length).trim();
    return pattern ? { action, target: { kind: "regex", value: pattern } } : null;
  }
  return { action, target: { kind: "prefix", value } };
}

/** Actions predexec recognizes but never performs — their grants are ignored. */
const IGNORED_ACTIONS = new Set(["write_file", "read_url", "execute_url", "mcp", "unsandboxed"]);
const TOOL_PERMISSIONS = new Set(["always-proceed", "request-review", "strict"]);

/** agy's documented transparent wrappers — used for ALLOW matching only (narrow on purpose). */
const AGY_WRAPPERS: WrapperInspectionOptions = {
  wrappers: new Set(["timeout", "nohup", "nice", "env"]),
  optionTakingWrappers: new Set(["timeout", "nice", "env"]),
};

/** Constructs that make agy require an exact full-line match (see module header). */
const EXACT_ONLY_RE = /\$\(|`|<\(|>\(|\{[^}\s]*,[^}\s]*\}/;

type CommandMatcher = (tokens: string[]) => boolean;
interface CommandGrant {
  label: string;
  /** `command(*)`: matches every command, substitution constructs included. */
  any: boolean;
  /** The verbatim target, for the exact full-line match. */
  exact: string | null;
  matches: CommandMatcher;
  /** Could this grant match some command run by `head` (its first word, R1)? */
  headMatches: (head: string) => boolean;
}
interface PathGrant {
  label: string;
  any: boolean;
  /** Candidate absolute paths (lexical + realpath), below any of which the grant applies. */
  paths: string[];
}

interface Compiled {
  deny: { commands: CommandGrant[]; paths: PathGrant[] };
  ask: { commands: CommandGrant[]; paths: PathGrant[] };
  allow: { commands: CommandGrant[]; paths: PathGrant[] };
  /** Fail-closed reasons from deny/ask grants predexec cannot evaluate. */
  brokenShell: string | null;
  brokenTool: string | null;
  strict: boolean;
  strictReason: string;
  confineToWorkspace: boolean;
  /** Home dir shell operands' `~` expands to. */
  home: string;
}

/**
 * A regex grant part as the literal word it matches, or null when it is not a
 * plain literal (metacharacters, anchors, alternation). A null word in the head
 * position could match any command (R1 fails closed), so only a literal regex
 * like `/usr/bin/cat` or `timeout 5 cat` is matched by basename and through
 * wrappers.
 */
function regexLiteral(part: string): string | null {
  if (!/^(?:\\[^A-Za-z0-9]|[^\\.^$|?*+()[\]{}])+$/.test(part)) return null;
  return part.replace(/\\(.)/g, "$1");
}

function compileCommandGrant(grant: AntigravityGrant, label: string): CommandGrant | null {
  const { kind, value } = grant.target;
  if (kind === "any") return { label, any: true, exact: null, matches: () => true, headMatches: () => true };
  if (kind === "prefix") {
    let want: string[];
    try {
      want = tokenizeShellWords(value);
    } catch {
      return null;
    }
    if (want.length === 0) return null;
    return {
      label,
      any: false,
      exact: value,
      matches: (tokens) => tokens.length >= want.length && want.every((w, i) => tokens[i] === w),
      headMatches: (head) => ruleHeadCouldMatch(want, head, { glob: false }),
    };
  }
  const parts = value.split(/\s+/).filter(Boolean);
  const res: RegExp[] = [];
  for (const part of parts) {
    if (!isSafeRegex(part)) return null;
    try {
      res.push(new RegExp(`^(?:${part})$`));
    } catch {
      return null;
    }
  }
  if (res.length === 0) return null;
  return {
    label,
    any: false,
    exact: null,
    matches: (tokens) => tokens.length >= res.length && res.every((re, i) => re.test(tokens[i]!)),
    headMatches: (head) => ruleHeadCouldMatch(parts.map(regexLiteral), head, { glob: false }),
  };
}

function pathVariants(p: string): string[] {
  const out = [p];
  try {
    const real = realpathSync(p);
    if (real !== p) out.push(real);
  } catch {
    // Not on disk (yet): resolve the nearest existing ancestor so a
    // symlinked parent (macOS /var → /private/var) still compares equal.
    let dir = dirname(p);
    const rest = [basename(p)];
    while (dir !== dirname(dir)) {
      try {
        const real = join(realpathSync(dir), ...rest);
        if (real !== p) out.push(real);
        break;
      } catch {
        rest.unshift(basename(dir));
        dir = dirname(dir);
      }
    }
  }
  return out;
}

const isInside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

function compilePathGrant(grant: AntigravityGrant, label: string, bases: string[], home: string): PathGrant | null {
  const { kind, value } = grant.target;
  if (kind === "any") return { label, any: true, paths: [] };
  if (kind === "regex") return null;
  // Globs and env vars (`$HOME/...`) are not part of the documented
  // read_file syntax; refuse to guess (fails closed in deny/ask).
  if (/[*?[\]$]/.test(value)) return null;
  let target = value;
  if (target === "~" || target.startsWith("~/")) target = join(home, target.slice(1));
  const roots = isAbsolute(target) ? [resolve(target)] : bases.map((b) => resolve(b, target));
  return { label, any: false, paths: [...new Set(roots.flatMap(pathVariants))] };
}

function readSettings(file: string): { settings: Record<string, unknown> | null } | { error: string } {
  if (!existsSync(file)) return { settings: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { error: `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `${file} is not a JSON object` };
  }
  return { settings: parsed as Record<string, unknown> };
}

function compile(settings: Record<string, unknown>, file: string, workspace: string, home: string): Compiled | string {
  const perms = settings.permissions;
  if (perms !== undefined && (typeof perms !== "object" || perms === null || Array.isArray(perms))) {
    return `${file}: "permissions" is not an object`;
  }
  const tp = settings.toolPermission;
  if (tp !== undefined && typeof tp !== "string") return `${file}: "toolPermission" is not a string`;
  const nwa = settings.allowNonWorkspaceAccess;
  if (nwa !== undefined && typeof nwa !== "boolean") return `${file}: "allowNonWorkspaceAccess" is not a boolean`;

  const out: Compiled = {
    deny: { commands: [], paths: [] },
    ask: { commands: [], paths: [] },
    allow: { commands: [], paths: [] },
    brokenShell: null,
    brokenTool: null,
    strict: tp !== undefined && tp !== "always-proceed" && tp !== "request-review",
    strictReason: tp !== undefined && !TOOL_PERMISSIONS.has(tp)
      ? `toolPermission "${tp}" is not a known mode — treated as strict`
      : "toolPermission is strict",
    confineToWorkspace: nwa === false,
    home,
  };

  for (const list of ["deny", "ask", "allow"] as const) {
    const raw = (perms as Record<string, unknown> | undefined)?.[list];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) return `${file}: "permissions.${list}" is not an array`;
    const bucket = out[list];
    for (const entry of raw) {
      const label = `${list}: ${String(entry)}`;
      const grant = typeof entry === "string" ? parseAntigravityGrant(entry) : null;
      const failBoth = () => {
        if (list === "allow") return;
        const why = `${list} grant ${JSON.stringify(entry)} is not a grant predexec can evaluate`;
        out.brokenShell ??= why;
        out.brokenTool ??= why;
      };
      if (!grant) {
        failBoth();
        continue;
      }
      if (grant.action === "command") {
        const compiled = compileCommandGrant(grant, label);
        if (compiled) bucket.commands.push(compiled);
        else if (list !== "allow") {
          out.brokenShell ??= `${list} grant ${JSON.stringify(entry)} cannot be evaluated safely (unsafe or invalid regex:)`;
        }
      } else if (grant.action === "read_file" || (grant.action === "write_file" && list === "allow")) {
        // Write implies read for allows. A write_file deny does not deny reads.
        const compiled = compilePathGrant(grant, label, [workspace], home);
        if (compiled) bucket.paths.push(compiled);
        else if (list !== "allow") {
          out.brokenTool ??= `${list} grant ${JSON.stringify(entry)} uses a read_file target predexec cannot evaluate`;
        }
      } else if (!IGNORED_ACTIONS.has(grant.action)) {
        failBoth();
      }
    }
  }
  return out;
}

/** Every token form a deny/ask grant is tried against (broad on purpose). */
function denyForms(segment: string): string[][] {
  const raw = tokenizeShellWords(segment);
  const stripped = stripLeadingAssignmentsAndWrappers(raw);
  const forms = [raw, stripped];
  for (const toks of [raw, stripped]) {
    const head = toks[0];
    if (head?.includes("/") && basename(head)) forms.push([basename(head), ...toks.slice(1)]);
  }
  return forms;
}

/** Token forms an allow grant may match (narrow: agy's own transparent wrappers only). */
function allowForms(segment: string): string[][] {
  const raw = tokenizeShellWords(segment);
  return [raw, stripLeadingAssignmentsAndWrappers(raw, AGY_WRAPPERS)];
}

function segmentsOf(text: string): string[] {
  const out: string[] = [];
  // Shell removes `\<newline>` before word splitting: `ca\<nl>t` is `cat`.
  for (const line of text.replace(/\\\r?\n/g, "").split("\n")) {
    for (const segment of splitCommandSegments(line)) {
      const trimmed = segment.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function checkShell(cmd: string, c: Compiled, ctx: PolicyCheckContext): PolicyVerdict {
  if (c.brokenShell) return `${c.brokenShell} — predexec stops rather than guess`;
  const line = cmd.trim();
  const inspected = inspectCommandSubstitutionTree(cmd);
  const texts = inspected.commands.length > 0 ? inspected.commands : [cmd];
  for (const bucket of [c.deny, c.ask]) {
    for (const g of bucket.commands) {
      if (g.exact !== null && g.exact === line) return g.label;
    }
    for (const text of texts) {
      for (const segment of segmentsOf(text)) {
        const forms = denyForms(segment);
        const hit = bucket.commands.find((g) => forms.some((toks) => g.matches(toks)));
        if (hit) return hit.label;
      }
    }
  }
  if (!inspected.complete) return "incomplete shell syntax (policy inspection budget exceeded)";
  // A data-fed operand (`echo .env | xargs cat`) is invisible to a grant
  // matched against command tokens, and to read_file grants, which see only
  // named paths: any deny/ask that could apply to the receiving command stops it.
  const readGrant = c.deny.paths[0] ?? c.ask.paths[0];
  for (const entry of commandsWithUnresolvableOperands(cmd)) {
    const grant = [...c.deny.commands, ...c.ask.commands].find((g) => g.headMatches(entry.head));
    if (grant) return describeUnresolvableOperand(entry, `your Antigravity grant "${grant.label}"`);
    if (readGrant && operandHeadMayReadPaths(entry.head)) {
      return describeUnresolvableOperand(entry, `your Antigravity grant "${readGrant.label}"`);
    }
  }
  const pathHit = checkShellPaths(cmd, c, ctx);
  if (pathHit) return pathHit;
  if (!c.strict || ctx.variant) return null;

  if (c.allow.commands.some((g) => g.any || g.exact === line)) return null;
  if (EXACT_ONLY_RE.test(cmd)) {
    return `${c.strictReason} and this command uses substitution/expansion, which needs an exact command(...) allow`;
  }
  for (const segment of segmentsOf(cmd)) {
    const forms = allowForms(segment);
    if (!c.allow.commands.some((g) => forms.some((toks) => g.matches(toks)))) {
      return `${c.strictReason} and no command(...) allow covers "${segment}"`;
    }
  }
  return null;
}

/**
 * read_file deny/ask against the paths a shell command names (E-E): every
 * operand of every head, `<` targets and expanded globs — agy's grant is on
 * the file, whatever program opens it. As with grep/find/ls tool ops, a
 * directory operand containing a denied path stops too (`grep -r KEY .`).
 */
function checkShellPaths(cmd: string, c: Compiled, ctx: PolicyCheckContext): PolicyVerdict {
  const grants = [...c.deny.paths, ...c.ask.paths];
  if (grants.length === 0 && !c.brokenTool) return null;
  const { paths, unresolved, complete } = resolveShellPathOperands(cmd, { cwd: ctx.cwd, root: ctx.sessionRoot, home: c.home });
  const label = grants[0]?.label ?? c.brokenTool;
  if (unresolved !== null) return `unresolvable shell operand '${unresolved}' (your Antigravity grant "${label}" is in effect; name the file literally)`;
  if (c.brokenTool && paths.length > 0) return `${c.brokenTool} — predexec stops rather than guess`;
  for (const path of paths) {
    const candidates = pathVariants(path);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      // not on disk: only a direct match applies
    }
    const hit = grants.find(
      (g) => pathMatches(g, candidates) || (isDir && g.paths.some((gp) => candidates.some((p) => isInside(p, gp)))),
    );
    if (hit) return hit.label;
  }
  return complete ? null : "incomplete shell syntax (read_file inspection budget exceeded)";
}

function pathMatches(g: PathGrant, candidates: string[]): boolean {
  return g.any || g.paths.some((root) => candidates.some((p) => isInside(root, p)));
}

function checkToolOp(op: Exclude<Operation, string>, c: Compiled, ctx: PolicyCheckContext, workspace: string): PolicyVerdict {
  if (c.brokenTool) return `${c.brokenTool} — predexec stops rather than guess`;
  // The engine hands tool-op paths already normalized to session-root-relative
  // (or absolute when escaping); an omitted path means the node cwd.
  const target = typeof op.path === "string" ? resolve(ctx.sessionRoot, op.path) : resolve(ctx.cwd);
  const candidates = pathVariants(target);
  // grep/find/ls (and any tool predexec does not know to be single-file)
  // read everything below their target, so a deny/ask on a path INSIDE the
  // searched directory applies too — `grep KEY .` must not read a denied `.env`.
  const recursive = op.tool !== "read";
  for (const bucket of [c.deny, c.ask]) {
    const hit = bucket.paths.find(
      (g) => pathMatches(g, candidates) || (recursive && g.paths.some((gp) => candidates.some((p) => isInside(p, gp)))),
    );
    if (hit) return hit.label;
  }
  if (c.confineToWorkspace) {
    const ws = pathVariants(workspace);
    if (!candidates.some((p) => ws.some((w) => isInside(w, p)))) {
      return `allowNonWorkspaceAccess is false and ${target} is outside the workspace`;
    }
  }
  if (c.strict && !ctx.variant && !c.allow.paths.some((g) => pathMatches(g, candidates))) {
    return `${c.strictReason} and no read_file(...) allow covers ${target}`;
  }
  return null;
}

/**
 * Build the operation-aware policy callback. Settings are read once per
 * construction; the server builds a fresh checker per tool call so an edit
 * applies immediately.
 */
export function createAntigravityPolicyChecker(opts: AntigravityPolicyOptions): OperationPolicyChecker {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const workspace = resolve(opts.cwd);
  const file = join(home, ".gemini", "antigravity-cli", "settings.json");

  const read = readSettings(file);
  let compiled: Compiled | string | null;
  if ("error" in read) compiled = read.error;
  else compiled = read.settings === null ? null : compile(read.settings, file, workspace, home);

  if (typeof compiled === "string") {
    const why =
      `cannot read your Antigravity permission settings (${compiled}) — ` +
      "predexec stops rather than run operations your grants might deny; fix that file to continue";
    return () => why;
  }
  if (compiled === null) return () => null;
  const c = compiled;
  return (operation, ctx) => {
    try {
      if (typeof operation === "string") return checkShell(operation, c, ctx);
      if (operation.tool === "bash") {
        return typeof operation.command === "string" ? checkShell(operation.command, c, ctx) : null;
      }
      return checkToolOp(operation, c, ctx, workspace);
    } catch {
      return "incomplete shell syntax (policy inspection failed)";
    }
  };
}

/**
 * Resolve the session root for `--host antigravity`.
 *
 * agy starts a workspace MCP server in its LAUNCH dir (which may be a subdir),
 * and a plugin server in the plugin's own dir with `PLUGIN_ROOT` set (both
 * measured, docs/research/antigravity.md §a). So, in order: `--root` /
 * `PREDEXEC_ROOT` if given (must be an existing directory); an error when
 * running as a plugin (cwd == PLUGIN_ROOT) — the plugin dir is never the
 * workspace (also when cwd is inside PLUGIN_ROOT); else the nearest ancestor
 * of cwd holding `.git` or `.agents` that lies strictly below $HOME — never
 * $HOME itself or an ancestor of it (controller ruling R49); else cwd.
 */
export function resolveAntigravityRoot(opts: {
  cwd: string;
  root?: string;
  env?: NodeJS.ProcessEnv;
}): { root: string } | { error: string } {
  const env = opts.env ?? process.env;
  const cwd = resolve(opts.cwd);
  const explicit = opts.root || env.PREDEXEC_ROOT;
  if (explicit) {
    const root = resolve(cwd, explicit);
    let isDir = false;
    try {
      isDir = statSync(root).isDirectory();
    } catch {
      // handled below
    }
    if (!isDir) {
      return { error: `predexec: the session root ${root} (from ${opts.root ? "--root" : "PREDEXEC_ROOT"}) is not a directory` };
    }
    return { root };
  }
  const pluginRoot = env.PLUGIN_ROOT;
  if (pluginRoot && insidePath(pluginRoot, cwd)) {
    return {
      error:
        "predexec: running as an Antigravity plugin server, whose working directory is the plugin's own directory, " +
        "not your workspace — so predexec does not know which directory to read. Set the workspace explicitly: " +
        "add `--root <workspace dir>` to the server args, or set PREDEXEC_ROOT=<workspace dir> in the server env. " +
        "Fall back to normal tool calling until then.",
    };
  }
  // Never select $HOME or an ancestor of it by walking (a stray `~/.agents`
  // or `~/.git` must not widen the root to the whole home dir): stop at the
  // first directory that is not strictly below $HOME. cwd == $HOME still
  // yields $HOME, but only through the cwd fallback below.
  const home = env.HOME || homedir();
  for (let dir = cwd; !insidePath(dir, home); dir = dirname(dir)) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".agents"))) return { root: dir };
    if (dirname(dir) === dir) break;
  }
  return { root: cwd };
}

/** Is `p` at or below `root`, comparing lexical paths and realpaths? */
function insidePath(root: string, p: string): boolean {
  const vr = pathVariants(resolve(root));
  const vp = pathVariants(resolve(p));
  return vr.some((r) => vp.some((x) => isInside(r, x)));
}
