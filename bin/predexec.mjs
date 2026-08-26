#!/usr/bin/env node
/**
 * predexec CLI — `doctor` (install diagnostics) and `stats` (request accounting).
 *
 * Plain JS on node builtins only (no TS loader, no deps) so `npx -y predexec`
 * works anywhere. Check functions take base paths as parameters (homedir
 * defaults) so tests can point them at fixtures; `main()` only runs when
 * executed directly.
 */

import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

// ── shared ────────────────────────────────────────────────

/** Twin of stats.ts statsFilePath (kept in sync; asserted by unit test). */
export function statsFilePath(env = process.env) {
  const dir =
    env.PREDEXEC_STATE_DIR ||
    (env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "predexec") : join(homedir(), ".local", "state", "predexec"));
  return join(dir, "stats.jsonl");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Strip // and /* *\/ comments so `.jsonc` configs parse (opencode accepts both
 * `opencode.json` and `opencode.jsonc`). String-aware, so the `//` inside a
 * `"$schema": "https://…"` value survives.
 */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") (inLine = false), (out += c);
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") (inBlock = false), i++;
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") (out += next ?? ""), i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') (inString = true), (out += c);
    else if (c === "/" && next === "/") (inLine = true), i++;
    else if (c === "/" && next === "*") (inBlock = true), i++;
    else out += c;
  }
  return out;
}

function readJsonc(path) {
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Twin of mcp/toml-lite.ts parseTomlLite (kept in sync; asserted by the
 * parity test in __tests__/doctor.test.ts). Deliberately SMALL, fail-closed
 * TOML subset reader for `~/.codex/config.toml`: parse the subset
 * confidently, or return `{ ok: false, error }` naming the offending line —
 * never a silent wrong parse. Added here in Task 3; consumed by doctor in
 * Task 6. See mcp/toml-lite.ts for the full subset writeup.
 */
class TomlLineError extends Error {
  constructor(lineNo, message) {
    super(message);
    this.lineNo = lineNo;
  }
}

const TOML_ESCAPES = { '"': '"', "\\": "\\", n: "\n", t: "\t" };

function tomlFirstUnquotedIndex(line, target) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (q === '"' && c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === target) return i;
  }
  return -1;
}

function tomlStripComment(line) {
  const idx = tomlFirstUnquotedIndex(line, "#");
  return idx === -1 ? line : line.slice(0, idx);
}

function tomlParseBasicString(s, pos) {
  let i = pos + 1;
  let out = "";
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "\n") break;
    if (c === '"') return { value: out, pos: i + 1 };
    if (c === "\\") {
      const esc = TOML_ESCAPES[s[i + 1] ?? ""];
      if (esc === undefined) throw new Error(`unsupported escape sequence "\\${s[i + 1] ?? ""}"`);
      (out += esc), i++;
    } else out += c;
  }
  throw new Error("unterminated string");
}

function tomlParseLiteralString(s, pos) {
  const end = s.indexOf("'", pos + 1);
  if (end === -1 || s.slice(pos, end).includes("\n")) throw new Error("unterminated string");
  return { value: s.slice(pos + 1, end), pos: end + 1 };
}

function tomlParseKeyToken(text) {
  if (text[0] === '"' || text[0] === "'") {
    const r = text[0] === '"' ? tomlParseBasicString(text, 0) : tomlParseLiteralString(text, 0);
    if (r.pos !== text.length) throw new Error(`invalid key "${text}"`);
    return r.value;
  }
  if (/^[A-Za-z0-9_-]+$/.test(text)) return text;
  throw new Error(`invalid key "${text}"`);
}

function tomlSplitDottedKey(s) {
  const parts = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (q === '"' && c === "\\") (cur += s[i + 1] ?? ""), i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") (q = c), (cur += c);
    else if (c === ".") (parts.push(cur.trim()), (cur = ""));
    else cur += c;
  }
  parts.push(cur.trim());
  return parts.map(tomlParseKeyToken);
}

function tomlArrayIsClosed(text) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (q === '"' && c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
  }
  return depth <= 0;
}

function tomlParseBareValue(s, pos) {
  let i = pos;
  while (i < s.length && !/[\s,\]]/.test(s[i])) i++;
  const t = s.slice(pos, i);
  if (t === "true" || t === "false") return { value: t === "true", pos: i };
  if (/^[+-]?\d+$/.test(t)) return { value: parseInt(t, 10), pos: i };
  if (/^[+-]?\d+\.\d+([eE][+-]?\d+)?$/.test(t)) return { value: parseFloat(t), pos: i };
  throw new Error(`unsupported value "${t}"`);
}

function tomlParseValue(s, pos, insideArray) {
  while (pos < s.length && /\s/.test(s[pos])) pos++;
  if (pos >= s.length) throw new Error("missing value");
  const c = s[pos];
  if (c === '"') return tomlParseBasicString(s, pos);
  if (c === "'") return tomlParseLiteralString(s, pos);
  if (c === "{") throw new Error("inline tables are not supported");
  if (c === "[") {
    if (insideArray) throw new Error("nested arrays are not supported");
    return tomlParseArray(s, pos);
  }
  return tomlParseBareValue(s, pos);
}

function tomlParseArray(s, pos) {
  let i = pos + 1;
  const arr = [];
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) throw new Error("unterminated array");
    if (s[i] === "]") return { value: arr, pos: i + 1 };
    const r = tomlParseValue(s, i, true);
    arr.push(r.value);
    i = r.pos;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === ",") i++;
    else if (s[i] === "]") return { value: arr, pos: i + 1 };
    else throw new Error('expected "," or "]" in array');
  }
}

function tomlParseFullValue(text) {
  const r = tomlParseValue(text, 0, false);
  if (text.slice(r.pos).trim() !== "") throw new Error("unexpected trailing content after value");
  return r.value;
}

export function parseTomlLite(text) {
  try {
    const lines = text.split(/\r\n|\n/).map(tomlStripComment);
    const root = {};
    let current = root;
    let i = 0;
    while (i < lines.length) {
      const lineNo = i + 1;
      const line = lines[i].trim();
      i++;
      if (line === "") continue;

      try {
        if (line[0] === "[") {
          if (line[1] === "[") throw new Error('array-of-tables ("[[...]]") are not supported');
          if (!line.endsWith("]")) throw new Error("malformed table header");
          let node = root;
          for (const seg of tomlSplitDottedKey(line.slice(1, -1))) {
            const existing = node[seg];
            if (existing === undefined) node[seg] = {};
            else if (typeof existing !== "object" || Array.isArray(existing))
              throw new Error(`cannot redefine "${seg}" as a table`);
            node = node[seg];
          }
          current = node;
          continue;
        }

        const eq = tomlFirstUnquotedIndex(line, "=");
        if (eq === -1) throw new Error("expected key = value");
        const keyText = line.slice(0, eq).trim();
        if (keyText[0] !== '"' && keyText[0] !== "'" && keyText.includes("."))
          throw new Error("dotted keys are not supported (use a [table.sub] header instead)");
        const key = tomlParseKeyToken(keyText);

        let valueText = line.slice(eq + 1).trim();
        while (valueText[0] === "[" && !tomlArrayIsClosed(valueText)) {
          if (i >= lines.length) throw new Error("unterminated array");
          (valueText += "\n" + lines[i]), i++;
        }
        const value = tomlParseFullValue(valueText);
        if (Object.prototype.hasOwnProperty.call(current, key)) throw new Error(`duplicate key "${key}"`);
        current[key] = value;
      } catch (e) {
        throw new TomlLineError(lineNo, e.message);
      }
    }
    return { ok: true, value: root };
  } catch (e) {
    if (e instanceof TomlLineError) return { ok: false, error: `line ${e.lineNo}: ${e.message}` };
    throw e;
  }
}

/** PATH lookup with no subprocess — used to tell "harness absent" from "harness unwired". */
export function onPath(bin, env = process.env) {
  const dirs = (env.PATH || "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = process.platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  return dirs.some((d) => exts.some((ext) => existsSync(join(d, bin + ext))));
}

// ── doctor checks ─────────────────────────────────────────
// Each check returns { name, status, detail?, hint? } where status is one of:
//   "ok"   — wired and healthy
//   "fail" — predexec IS wired here but is broken (this is what sets exit code 1)
//   "info" — harness is installed but predexec is not wired into it (actionable, not a failure)
//   "skip" — harness is not installed on this machine (nothing to say)
// Only "fail" is an error: a machine that simply doesn't use pi or opencode is
// a healthy machine, and doctor must exit 0 there.

export function checkNodeVersion(version = process.versions.node) {
  const major = Number(version.split(".")[0]);
  return major >= 22
    ? { name: `node ${version} (>= 22)`, status: "ok" }
    : { name: `node ${version}`, status: "fail", hint: "predexec needs Node 22+ (engines.node)." };
}

/**
 * Normalize a pi `packages` entry to its source string. pi accepts both the
 * bare string form and the object form `{ source, extensions, skills }`
 * (pi docs, packages.md "Filter what a package loads"), so a doctor that only
 * looked at strings reported a false failure for object-form users.
 */
export function piPackageSource(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
  return null;
}

/**
 * pi: settings entry + installed package + zod sibling.
 *
 * pi resolves packages from two scopes (pi docs, packages.md): user settings at
 * `~/.pi/agent/settings.json` installing into `~/.pi/agent/npm/`, and project
 * settings at `.pi/settings.json` installing into `.pi/npm/`. Both are checked.
 */
export function checkPi(opts = {}) {
  const piAgentDir = opts.piAgentDir ?? join(homedir(), ".pi", "agent");
  const cwd = opts.cwd ?? process.cwd();
  const installed = opts.installed ?? onPath("pi");

  const scopes = [
    { label: "user", settings: join(piAgentDir, "settings.json"), root: piAgentDir },
    { label: "project", settings: join(cwd, ".pi", "settings.json"), root: join(cwd, ".pi") },
  ].map((s) => ({ ...s, json: readJson(s.settings) }));

  const configured = scopes.filter((s) => s.json);
  if (configured.length === 0) {
    return installed
      ? [{ name: "pi: installed, predexec not registered", status: "info", hint: "run `pi install npm:predexec`" }]
      : [{ name: "pi not installed", status: "skip", detail: "no pi on PATH and no settings.json" }];
  }

  const wired = configured
    .map((s) => {
      const packages = Array.isArray(s.json.packages) ? s.json.packages : [];
      const entry = packages.map(piPackageSource).find((src) => src && /(^|[:/])predexec(@|$)/.test(src));
      return entry ? { ...s, entry } : null;
    })
    .filter(Boolean);

  if (wired.length === 0) {
    return [
      {
        name: "pi: configured, predexec not registered",
        status: "info",
        detail: configured.map((s) => s.settings).join(", "),
        hint: "run `pi install npm:predexec` (or `-l` for project scope)",
      },
    ];
  }

  const checks = [];
  for (const scope of wired) {
    checks.push({ name: `pi settings (${scope.label}): ${scope.entry}`, status: "ok", detail: scope.settings });

    const pkgDir = join(scope.root, "npm", "node_modules", "predexec");
    const pkg = readJson(join(pkgDir, "package.json"));
    checks.push(
      pkg
        ? { name: `pi install (${scope.label}): predexec@${pkg.version}`, status: "ok", detail: pkgDir }
        : {
            name: `pi install (${scope.label}): package present`,
            status: "fail",
            detail: pkgDir,
            hint: "run `pi install npm:predexec` (or `pi update --extensions`)",
          },
    );

    if (!pkg) continue;

    // pi's resolveExtensionEntries requires existsSync on each manifest path and
    // silently skips a miss — the same class of bug as the 0.1.8 bin issue, so a
    // packaging slip that drops a declared file is a silent no-op, not a doctor
    // failure, unless we check it ourselves.
    for (const entry of [...(pkg.pi?.extensions ?? []), ...(pkg.pi?.skills ?? [])]) {
      if (!existsSync(join(pkgDir, entry))) {
        checks.push({
          name: `pi manifest entry missing: ${entry}`,
          status: "fail",
          hint: "the installed package does not contain this file — reinstall/upgrade predexec (pi silently skips missing entries)",
        });
      }
    }

    // Two locations, like opencode's cache check: nested under the predexec
    // package (npm dedupes less aggressively for a single top-level package) or
    // hoisted to the shared npm/node_modules root.
    const zod =
      readJson(join(pkgDir, "node_modules", "zod", "package.json")) ??
      readJson(join(scope.root, "npm", "node_modules", "zod", "package.json"));
    checks.push(
      zod
        ? { name: `pi install (${scope.label}): zod@${zod.version} present`, status: "ok" }
        : {
            name: `pi install (${scope.label}): zod dependency`,
            status: "fail",
            hint: "reinstall: `pi remove npm:predexec && pi install npm:predexec`",
          },
    );
  }
  return checks;
}

/**
 * Collect every opencode config that contributes to the effective config.
 *
 * opencode merges configs rather than replacing them, and walks up from the cwd
 * to the nearest git directory looking for `opencode.json` / `opencode.jsonc`
 * (https://opencode.ai/docs/config/). The previous first-match-wins lookup
 * reported a false failure whenever a project config existed without the plugin
 * entry while the global config had it.
 */
export function findOpencodeConfigs(cwd = process.cwd(), home = homedir()) {
  const found = [];
  const seen = new Set();
  const add = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const json = readJsonc(path);
    if (json) found.push({ path, json });
  };

  const root = parsePath(cwd).root;
  let dir = cwd;
  for (;;) {
    add(join(dir, "opencode.json"));
    add(join(dir, "opencode.jsonc"));
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }

  add(join(home, ".config", "opencode", "opencode.json"));
  add(join(home, ".config", "opencode", "opencode.jsonc"));
  return found;
}

/** opencode: config entry + cache install + zod + loader-contract shape. */
export function checkOpencode(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const cacheRoot = opts.cacheRoot ?? join(home, ".cache", "opencode", "packages");
  const installedOnPath = opts.installed ?? onPath("opencode");
  const checks = [];

  const configs = findOpencodeConfigs(cwd, home);
  if (configs.length === 0) {
    return installedOnPath
      ? [
          {
            name: "opencode: installed, predexec not registered",
            status: "info",
            hint: 'create opencode.json with "plugin": ["predexec"]',
          },
        ]
      : [{ name: "opencode not installed", status: "skip", detail: "no opencode on PATH and no opencode.json" }];
  }

  // Configs merge; the plugin may be declared in any of them.
  let entry = null;
  let entryPath = null;
  for (const config of configs) {
    const plugins = Array.isArray(config.json.plugin) ? config.json.plugin : [];
    const hit = plugins.find((p) => typeof p === "string" && /^predexec(@.*)?$/.test(p));
    if (hit) {
      entry = hit;
      entryPath = config.path;
      break;
    }
  }

  // A checked-out repo with .opencode/plugins/*.ts is loaded directly by
  // opencode without any config entry. That is a valid dev setup, but it is NOT
  // an install — label it so it is never mistaken for one.
  const localPlugin = [join(cwd, ".opencode", "plugins", "predexec.ts"), join(home, ".config", "opencode", "plugins", "predexec.ts")].find(
    (p) => existsSync(p),
  );

  if (!entry) {
    checks.push({
      name: localPlugin
        ? "opencode: loading predexec from a local plugin dir (dev checkout, not an install)"
        : "opencode: configured, predexec not registered",
      status: "info",
      detail: localPlugin ?? configs.map((c) => c.path).join(", "),
      hint: 'add "predexec" to the "plugin" array in opencode.json and restart opencode',
    });
    return checks;
  }

  // The live probe must run in the same scope the entry was declared in: a
  // project config only applies inside its own directory tree, while a global
  // config applies anywhere (so a neutral dir is the honest place to probe).
  const globalDir = join(home, ".config", "opencode");
  const probeCwd = dirname(entryPath) === globalDir ? null : dirname(entryPath);
  checks.push({ name: `opencode config: plugin "${entry}"`, status: "ok", detail: entryPath, probeCwd });

  // Cache install (any predexec / predexec@x dir).
  let cacheDirs = [];
  try {
    cacheDirs = readdirSync(cacheRoot).filter((d) => d === "predexec" || d.startsWith("predexec@"));
  } catch {
    /* no cache yet */
  }
  const installed = cacheDirs
    .map((d) => join(cacheRoot, d, "node_modules", "predexec"))
    .filter((p) => existsSync(join(p, "package.json")));
  if (installed.length === 0) {
    checks.push({
      name: "opencode cache: predexec installed",
      status: "fail",
      hint: "start opencode once so it fetches the plugin, or clear the cache and restart",
    });
    return checks;
  }

  for (const dir of installed) {
    const pkg = readJson(join(dir, "package.json"));
    checks.push({ name: `opencode cache: predexec@${pkg?.version ?? "?"}`, status: "ok", detail: dir });

    const zodOk =
      existsSync(join(dir, "node_modules", "zod", "package.json")) ||
      existsSync(join(dir, "..", "zod", "package.json"));
    checks.push(
      zodOk
        ? { name: "opencode cache: zod dependency present", status: "ok" }
        : {
            name: "opencode cache: zod dependency",
            status: "fail",
            hint: `clear ${join(dir, "..", "..")} and restart opencode (pre-0.1.1 installs lacked runtime deps)`,
          },
    );

    // Loader contract: opencode's readV1Plugin only reads the default export.
    let pluginSrc = "";
    try {
      const candidates = [
        pkg?.main ? join(dir, pkg.main) : null,
        join(dir, "dist", ".opencode", "plugins", "predexec.js"),
        join(dir, ".opencode", "plugins", "predexec.ts"),
      ].filter(Boolean);
      for (const file of candidates) {
        if (existsSync(file)) {
          pluginSrc = readFileSync(file, "utf8");
          break;
        }
      }
    } catch {
      /* handled below */
    }
    checks.push(
      pluginSrc.includes("export default")
        ? { name: "opencode cache: plugin default-exports { id, server }", status: "ok" }
        : pluginSrc.includes("exports.default")
          ? {
              // predexec 0.3.0 shipped a CJS-compiled opencode entry (a stray
              // .opencode/package.json without "type" made tsc's NodeNext emit
              // compile this one file to CJS). Distinct from the pre-0.1.1 case
              // below: clearing the cache re-fetches the same broken build.
              name: "opencode cache: plugin export shape",
              status: "fail",
              hint: "compiled as CommonJS — packaging bug in this predexec version; upgrade predexec (do not clear the cache, it will re-fetch the same build)",
            }
          : {
              name: "opencode cache: plugin export shape",
              status: "fail",
              hint: "cached version predates 0.1.1 (silently skipped by the loader) — clear the cache dir and restart opencode",
            },
    );
  }
  return checks;
}

/**
 * Claude Code: predexec ships there as an MCP server, so "installed" means a
 * server entry in one of the scopes `claude mcp add` writes to. Locations were
 * confirmed empirically against CLI 2.1.223 (add a server in a scratch repo and
 * diff the config), not inferred:
 *
 *   project  <project>/.mcp.json          → mcpServers
 *   user     ~/.claude.json               → mcpServers
 *   local    ~/.claude.json               → projects["<abs path>"].mcpServers
 *
 * A project-scope server sits at "Pending approval" until the user approves it
 * in an interactive session, which is `info` (actionable), never `fail`.
 */

/**
 * Plugin-form installs record themselves in `<configDir>/plugins/installed_plugins.json`
 * (measured empirically: `{ version, plugins: { "<name>@<marketplace>": [{ scope,
 * installPath, version, ... }] } }`), not in `.mcp.json` / `~/.claude.json` at all —
 * so a plugin-wrapper user was invisible to the mcp-scope scan above and saw
 * "not registered" while the server ran fine.
 */
export function findClaudeCodePlugin(configDir) {
  const path = join(configDir, "plugins", "installed_plugins.json");
  const data = readJson(path);
  const plugins = data && typeof data.plugins === "object" ? data.plugins : null;
  if (!plugins) return null;
  const key = Object.keys(plugins).find((k) => /^predexec(@|$)/.test(k));
  return key ? { key, path } : null;
}

export function checkClaudeCode(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const installed = opts.installed ?? onPath("claude");

  const configDir = opts.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const userConfig = readJson(join(home, ".claude.json")) ?? {};
  const projectMcp = readJson(join(cwd, ".mcp.json"));

  const named = (servers) =>
    servers && typeof servers === "object" ? Object.keys(servers).find((k) => /predexec/.test(k)) : undefined;

  const found = [
    { scope: "project", key: named(projectMcp?.mcpServers), where: join(cwd, ".mcp.json") },
    { scope: "user", key: named(userConfig.mcpServers), where: join(home, ".claude.json") },
    {
      scope: "local",
      key: named(userConfig.projects?.[cwd]?.mcpServers),
      where: `${join(home, ".claude.json")} → projects[${cwd}]`,
    },
  ].filter((s) => s.key);

  if (found.length === 0) {
    if (!installed && !existsSync(configDir)) {
      return [{ name: "claude code not installed", status: "skip", detail: "no claude on PATH and no ~/.claude" }];
    }
    const plugin = findClaudeCodePlugin(configDir);
    if (plugin) {
      return [{ name: "claude code: predexec plugin installed", status: "ok", detail: plugin.path }];
    }
    return [
      {
        name: "claude code: installed, predexec not registered",
        status: "info",
        // `--package=predexec` is load-bearing: `npx -y predexec-mcp` would look
        // for a REGISTRY PACKAGE of that name (there is none — predexec-mcp is a
        // bin inside the predexec package), so the bare form 404s.
        hint: "run `claude mcp add predexec -- npx -y --package=predexec predexec-mcp` (or install the plugin form — see README)",
      },
    ];
  }

  const checks = [];
  for (const hit of found) {
    checks.push({ name: `claude code mcp (${hit.scope}): "${hit.key}"`, status: "ok", detail: hit.where });

    if (hit.scope === "project") {
      // Approval is recorded per project in ~/.claude.json.
      const project = userConfig.projects?.[cwd] ?? {};
      const enabled = project.enabledMcpjsonServers ?? [];
      const disabled = project.disabledMcpjsonServers ?? [];
      if (disabled.includes(hit.key)) {
        checks.push({
          name: `claude code: "${hit.key}" is disabled for this project`,
          status: "info",
          hint: "re-enable it with `/mcp` inside claude",
        });
      } else if (!enabled.includes(hit.key)) {
        checks.push({
          name: `claude code: "${hit.key}" awaiting project approval`,
          status: "info",
          hint: "start `claude` in this directory and approve the project MCP server once",
        });
      }
    }
  }
  return checks;
}

/**
 * Codex CLI: `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) holds
 * predexec's registration under `[mcp_servers.predexec]`. Codex's own CLI
 * exposes `codex mcp get <name> --json` with a stable, measured shape
 * (CODEX-RESEARCH.md "Measured on this machine": `transport.command` /
 * `transport.args` / `enabled`) — prefer that when the `codex` binary is
 * reachable; fall back to a direct parseTomlLite read of config.toml
 * otherwise, mirroring how this file already reads opencode's config.
 *
 * A registration missing `--host codex` in its args is not healthy: without
 * that flag the predexec MCP server silently falls back to Claude Code's
 * policy+stats behavior (see steering.ts / mcp/policy-codex.ts), which is a
 * real but silent misconfiguration — warn (fail) on it, same tier as
 * `enabled = false` or a config.toml that fails to parse (fail-closed: an
 * unparseable file can't be confirmed healthy, so it can't be "ok").
 */
export function resolveCodexHome(opts = {}) {
  if (opts.codexHome) return opts.codexHome;
  const env = opts.env ?? process.env;
  if (env.CODEX_HOME) return env.CODEX_HOME;
  const home = opts.home ?? homedir();
  return join(home, ".codex");
}

function codexCommandExists(command, env) {
  if (!command) return false;
  return command.includes("/") || command.includes("\\") ? existsSync(command) : onPath(command, env);
}

function codexArgsHaveHostCodex(args) {
  // The launcher (`bin/predexec-mcp.mjs`'s `parseHostArg`) accepts both the
  // two-token `--host codex` form and the single-token `--host=codex` form —
  // a registration written the second way is fully healthy, not missing the
  // flag, so both must satisfy this check or doctor false-fails a working
  // install.
  if (args.includes("--host=codex")) return true;
  const idx = args.indexOf("--host");
  return idx !== -1 && args[idx + 1] === "codex";
}

export function checkCodex(opts = {}) {
  const env = opts.env ?? process.env;
  const codexHome = resolveCodexHome(opts);
  const codexBin = opts.codexBin ?? "codex";
  const installed = opts.installed ?? onPath(codexBin, env);
  const hasCodexHome = existsSync(codexHome);

  if (!installed && !hasCodexHome) {
    return [{ name: "codex not installed", status: "skip", detail: "no codex on PATH and no ~/.codex" }];
  }

  const checks = [];
  const runCodex = (args) => spawnSync(codexBin, args, { encoding: "utf8", env });

  if (installed) {
    const v = runCodex(["--version"]);
    const version = v.status === 0 && v.stdout ? v.stdout.trim().split("\n")[0] : null;
    checks.push(
      // `version` is already `codex --version`'s own stdout (e.g. "codex-cli
      // 0.149.1"), which names the tool itself — prefixing another "codex "
      // in front of it rendered as a doubled "codex codex-cli 0.149.1".
      version
        ? { name: `${version} (on PATH)`, status: "ok" }
        : { name: "codex: on PATH, but `codex --version` failed", status: "info", detail: (v.stderr || "").trim() || undefined },
    );
  }

  // Prefer `codex mcp get --json` when the binary is reachable; fall back to
  // a direct config.toml parse (below) when it is not, or when the json call
  // itself didn't yield a usable registration.
  let registration = null;
  const configPath = join(codexHome, "config.toml");

  if (installed) {
    const r = runCodex(["mcp", "get", "predexec", "--json"]);
    if (r.status === 0 && r.stdout) {
      try {
        const data = JSON.parse(r.stdout);
        registration = {
          command: data?.transport?.command ?? null,
          args: Array.isArray(data?.transport?.args) ? data.transport.args : [],
          enabled: data?.enabled !== false,
          source: "codex mcp get predexec --json",
        };
      } catch {
        /* malformed json — fall through to the on-disk parse below */
      }
    }
  }

  if (!registration && existsSync(configPath)) {
    const parsed = parseTomlLite(readFileSync(configPath, "utf8"));
    if (!parsed.ok) {
      checks.push({
        name: `codex config: ${configPath} does not parse`,
        status: "fail",
        detail: parsed.error,
        hint: "fix the TOML syntax in this file — predexec cannot confirm the registration while it fails to parse (fail-closed)",
      });
      return checks;
    }
    const server = parsed.value?.mcp_servers?.predexec;
    if (server) {
      registration = {
        command: server.command ?? null,
        args: Array.isArray(server.args) ? server.args : [],
        enabled: server.enabled !== false,
        source: configPath,
      };
    }
  }

  if (!registration) {
    checks.push({
      name: "codex: installed, predexec not registered",
      status: "info",
      // `--package=` is load-bearing (see checkClaudeCode's identical note):
      // `predexec-mcp` is a bin inside the `predexec` package, not a package
      // of its own. `--host codex` selects the Codex policy/stats adapter.
      hint: "run `codex mcp add predexec -- npx -y --package=predexec predexec-mcp --host codex`",
    });
    return checks;
  }

  checks.push({
    name: `codex mcp registration: "${registration.command} ${registration.args.join(" ")}"`.trim(),
    status: "ok",
    detail: registration.source,
  });

  if (!registration.enabled) {
    checks.push({
      name: "codex: predexec registration is disabled (enabled = false)",
      status: "fail",
      hint: "set `enabled = true` (or drop the key) in config.toml, or re-run `codex mcp add`",
    });
  }

  if (!codexArgsHaveHostCodex(registration.args)) {
    checks.push({
      name: "codex: registration is missing --host codex",
      status: "fail",
      hint: "append `--host codex` to the registered args — without it predexec silently falls back to Claude Code policy/stats behavior",
    });
  }

  if (!codexCommandExists(registration.command, env)) {
    checks.push({
      name: `codex: registered command not found: "${registration.command}"`,
      status: "fail",
      hint: "the command in this MCP registration does not resolve on this machine — reinstall or fix config.toml",
    });
  }

  return checks;
}

/**
 * Live probe: spawn `opencode serve` on a random high port and poll
 * /experimental/tool/ids for "predexec". The gold check for silent loader skips.
 *
 * Runs from a neutral directory on purpose. opencode auto-loads
 * `.opencode/plugins/*.ts` from the cwd, so probing from the predexec checkout
 * reported "registered" on machines where nothing was installed at all — the
 * probe was measuring the dev tree, not the install.
 */
export async function liveProbe({ timeoutMs = 12000, cwd = tmpdir(), expectRegistered = true } = {}) {
  const port = 4600 + Math.floor(Math.random() * 100);
  const child = spawn("opencode", ["serve", "--port", String(port)], { stdio: "ignore", cwd });
  const spawnFailed = new Promise((resolveP) => child.once("error", () => resolveP("spawn-error")));
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const failed = await Promise.race([spawnFailed, new Promise((r) => setTimeout(r, 500))]);
      if (failed === "spawn-error") {
        return { name: "live probe: opencode not installed", status: "skip", detail: "opencode binary not found" };
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/experimental/tool/ids`);
        const ids = await res.json();
        return Array.isArray(ids) && ids.includes("predexec")
          ? { name: "live probe: predexec registered in opencode", status: "ok", detail: `probed from ${cwd}` }
          : {
              name: "live probe: predexec registered in opencode",
              // Only a failure if the config says it SHOULD be registered — that
              // combination is the silent loader skip this probe exists to catch.
              status: expectRegistered ? "fail" : "info",
              detail: `probed from ${cwd} — tool ids: ${JSON.stringify(ids)}`,
              hint: expectRegistered
                ? "config declares the plugin but the loader skipped it — clear ~/.cache/opencode/packages and restart opencode"
                : "predexec is not wired into opencode (see above); this is expected",
            };
      } catch {
        /* server not up yet — keep polling */
      }
    }
    return {
      name: "live probe: opencode serve responded",
      status: "info",
      hint: "server never answered within the timeout — check `opencode serve` manually",
    };
  } finally {
    child.kill();
  }
}

// ── stats aggregation ─────────────────────────────────────

export function parseStatsLines(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.v === 1);
}

export function summarizeStats(records) {
  const summary = {
    runs: records.length,
    byHarness: {},
    byStoppedReason: {},
    ops: 0,
    requestsSaved: 0,
    edgesEvaluated: 0,
    edgesMatched: 0,
    avgDepth: 0,
  };
  for (const r of records) {
    summary.byHarness[r.harness] = (summary.byHarness[r.harness] ?? 0) + 1;
    summary.byStoppedReason[r.stoppedReason] = (summary.byStoppedReason[r.stoppedReason] ?? 0) + 1;
    summary.ops += r.ops ?? 0;
    summary.requestsSaved += r.requestsSaved ?? 0;
    summary.edgesEvaluated += r.edgesEvaluated ?? 0;
    summary.edgesMatched += r.edgesMatched ?? 0;
    summary.avgDepth += r.depthReached ?? 0;
  }
  if (records.length > 0) summary.avgDepth = summary.avgDepth / records.length;
  return summary;
}

// ── CLI ───────────────────────────────────────────────────

const GLYPH = { ok: "[x]", fail: "[!]", info: "[ ]", skip: "[-]" };

function printCheck(c) {
  console.log(`${GLYPH[c.status] ?? "[?]"} ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  if ((c.status === "fail" || c.status === "info") && c.hint) {
    console.log(`    ${c.status === "fail" ? "fix" : "to enable"}: ${c.hint}`);
  }
}

async function doctor(args) {
  const checks = [checkNodeVersion(), ...checkPi(), ...checkOpencode(), ...checkClaudeCode(), ...checkCodex()];
  if (args.includes("--live")) {
    // Only a silent loader skip counts as a failure — see liveProbe.
    const configCheck = checks.find((c) => c.status === "ok" && c.name.startsWith("opencode config:"));
    checks.push(
      await liveProbe({
        expectRegistered: Boolean(configCheck),
        ...(configCheck?.probeCwd ? { cwd: configCheck.probeCwd } : {}),
      }),
    );
  }
  console.log("predexec doctor\n");
  for (const c of checks) printCheck(c);

  const failed = checks.filter((c) => c.status === "fail").length;
  const info = checks.filter((c) => c.status === "info").length;
  if (failed > 0) console.log(`\n${failed} check(s) failed`);
  // "info" covers both "harness present but unwired" and "wired but needs one
  // more step" (e.g. project MCP approval), so the summary must not claim the
  // stronger of the two.
  else if (info > 0) console.log(`\nnothing broken — ${info} item(s) need a step to finish wiring`);
  else console.log("\nall checks passed");

  if (!args.includes("--live")) console.log("(run with --live to spawn opencode and probe tool registration)");
  return failed === 0 ? 0 : 1;
}

async function stats() {
  const file = statsFilePath();
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    console.log(`no runs recorded yet — ${file}`);
    return 0;
  }
  const records = parseStatsLines(text);
  if (records.length === 0) {
    console.log(`no runs recorded yet — ${file}`);
    return 0;
  }
  const s = summarizeStats(records);
  const hitRate = s.edgesEvaluated > 0 ? `${((s.edgesMatched / s.edgesEvaluated) * 100).toFixed(0)}%` : "n/a";
  console.log(`predexec stats — ${file}\n`);
  console.log(`runs:                 ${s.runs}  (${Object.entries(s.byHarness).map(([k, v]) => `${k}: ${v}`).join(", ")})`);
  console.log(`ops collapsed:        ${s.ops}`);
  console.log(`est. requests saved:  ${s.requestsSaved}`);
  console.log(`avg depth:            ${s.avgDepth.toFixed(1)}`);
  console.log(`edge hit rate:        ${hitRate}  (${s.edgesMatched}/${s.edgesEvaluated})`);
  console.log(`stops:                ${Object.entries(s.byStoppedReason).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  return 0;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "doctor") process.exit(await doctor(args));
  if (cmd === "stats") process.exit(await stats());
  if (cmd === "--version" || cmd === "-v") {
    const pkg = readJson(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
    console.log(pkg?.version ?? "unknown");
    process.exit(0);
  }
  const usage = "usage: predexec <doctor [--live] | stats | --version>";
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    console.log(usage);
    process.exit(0);
  }
  console.log(usage);
  process.exit(1);
}

/**
 * True when this file was executed directly rather than imported.
 *
 * npm installs `bin` entries as symlinks, so `process.argv[1]` is the symlink
 * (`node_modules/.bin/predexec`) while `import.meta.url` is the realpath'd
 * module URL — comparing them naively is always false, which silently turned
 * every `npx -y predexec …` invocation into a no-op that exited 0. realpath
 * resolves the symlink and pathToFileURL handles spaces, non-ASCII paths and
 * Windows drive letters that hand-built `file://` strings get wrong.
 */
export function isDirectInvocation(moduleUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  await main();
}
