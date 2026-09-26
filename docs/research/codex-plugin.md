# Codex plugin manifest — schema and live verification

Source: `openai/codex` GitHub repo at commit `25270df2615eb4da5b9d4a9a392226933fb096c5` (measuring
day, 2026-09-26); installed `codex-cli 0.154.0` (`codex --version`) on the measuring machine.
Paths below are `codex-rs/...` relative to that tree. The authoritative field-level spec ships
inside Codex's own plugin-creator skill sample:
`codex-rs/skills/src/assets/samples/plugin-creator/references/plugin-json-spec.md`.

## 1. Manifest schema (verified against source, not just the reference doc)

- **`.codex-plugin/plugin.json`** — required fields for a working (not just "validator-clean")
  plugin are just `name`, `description`, and whichever of `mcpServers`/`skills` you use.
  `codex-rs/core-plugins/src/manifest.rs:172` hardcodes the manifest path as literally
  `plugin_root.join(".codex-plugin/plugin.json")`. Real installed OpenAI plugins confirm this is
  lenient at runtime: `unified-computer-use`'s manifest is only
  `{name, version, description, mcpServers}` — no `author`, no `interface` block — and it loads
  and runs. The plugin-json-spec.md doc's "must include real values for ... `author.name` ..."
  validation note is for the **plugin-creator skill's own authoring linter**
  (`scripts/validate_plugin.py`), not the plugin loader itself; do not conflate the two.
- **Path resolution: relative to plugin ROOT, not to `.codex-plugin/`.** Confirmed at
  `manifest.rs:660-667`: every manifest path field (`skills`, `mcpServers` string form, `apps`,
  `hooks`) is resolved as `plugin_root.join(relative_path)` and then checked with
  `resolved.starts_with(plugin_root)`. `unified-computer-use`'s `"mcpServers": "./.mcp.json"`
  lives at the plugin root (sibling of `.codex-plugin/`), not inside it — this is why our
  `plugin.json` (which itself lives inside `.codex-plugin/`) points at
  `"./.codex-plugin/mcp.json"` rather than `"./mcp.json"`.
- **`mcpServers` companion file schema**: `{"mcpServers": {"<name>": {"command", "args",
  "env_vars", "cwd"?, ...}}}`. `env_vars` is a plain array of env-var **names** to forward from
  Codex's own process into the child — confirmed both by a real installed manifest
  (`computer-use`'s `.mcp.json`: `"env_vars": ["CODEX_HOME"]`) and by the Rust source: see §2.
- **`skills` REPLACES default discovery for that plugin — it does not supplement it.** This
  contradicts the reference doc's prose ("`skills`... are supplemented on top of default
  component discovery; they do not replace defaults"). The actual code,
  `codex-rs/core-plugins/src/loader.rs:1079-1097` (`plugin_skill_roots`):
  ```rust
  let mut paths = if manifest_paths.skills.is_empty() {
      default_skill_roots(plugin_root)   // plugin_root/skills, only if manifest omits `skills`
  } else {
      manifest_paths.skills.clone()      // manifest wins outright — no merge
  };
  ```
  `default_skill_roots` only fires when `manifest_paths.skills.is_empty()`. Declaring
  `"skills": "./skills/codex/"` in our `plugin.json` means Codex loads **only** that directory's
  immediate children as skill roots (`<root>/<skill-name>/SKILL.md`, one level, matching every
  real installed plugin inspected: `computer-use/skills/computer-use/SKILL.md`,
  `superpowers/skills/<name>/SKILL.md`) and never touches the plugin's bare `skills/` directory
  at all. Belt-and-suspenders: this repo's bare `skills/` at the plugin root contains
  `skills/claude/`, `skills/codex/`, `skills/opencode/` — even if Codex *did* fall back to a
  default scan, none of those three directories directly contains a `SKILL.md` (it's one level
  deeper, under `<harness>/predexec/SKILL.md`), so a default one-level scan would find nothing
  either way. Both independent facts point to the same conclusion for **Controller ruling R4**:
  Codex sees only the `codex` skill from this plugin, never `claude`'s or `opencode`'s.
- **Marketplace manifest.** `RawMarketplaceManifest` (`marketplace.rs:970-975`) is just `{name,
  interface?, plugins}`; there is **no top-level `version` field** in the real schema (confirmed
  absent from every installed marketplace.json inspected), so `sync-plugin-version.mjs` does not
  invent one for `.agents/plugins/marketplace.json` — unlike `.claude-plugin/marketplace.json`,
  which is this repo's own convention, not something Claude Code's schema requires either.
  `RawMarketplaceManifestPlugin.policy` and `.category` are `#[serde(default)]` (optional at
  parse time) even though the reference doc says "always include" — kept them anyway, matching
  every real installed marketplace.
- **`source` accepts either a bare string or `{source, path}`.** `RawMarketplaceManifestPluginSource`
  is `#[serde(untagged)]` over `Path(String) | Object(...)`. We used the object form
  (`{"source": "local", "path": "./"}`) to match the doc's own worked example and the majority of
  real installed marketplaces, but a bare `"./"` string (matching this repo's existing
  `.claude-plugin/marketplace.json` convention) would parse identically.
- **`path: "."` / `"./"` resolves to the marketplace root itself** —
  `marketplace.rs:662`: `"." | "./" => return marketplace_root_dir(marketplace_path)`. This is a
  literal, unconditional branch: a marketplace whose manifest lives at
  `<repo>/.agents/plugins/marketplace.json` and whose one plugin entry has `path: "./"` resolves
  `plugin_root` to `<repo>` itself — i.e., "this whole repo is the plugin," the same
  self-hosting pattern this repo already uses for `.claude-plugin/marketplace.json`
  (`source: "./"`). Confirmed live in §3.

## 2. CX-4 — CODEX_HOME forwarding (source-verified, replaces the CODEX-RESEARCH.md citations)

`codex-rs/rmcp-client/src/stdio_server_launcher.rs` — the file the old dangling
`CODEX-RESEARCH.md §4`/`§5` citations pointed at — is real and current at the measured commit.
For a **local** stdio MCP server (what a `command`+`args` registration is, including ours),
`LocalStdioServerLauncher::launch_server` builds the child's environment via
`create_env_for_mcp_server` (`codex-rs/rmcp-client/src/utils.rs:16-56`):

```rust
pub(crate) fn create_env_for_mcp_server(
    extra_env: Option<HashMap<OsString, OsString>>,
    env_vars: &[McpServerEnvVar],
) -> Result<HashMap<OsString, OsString>> {
    let additional_env_vars = local_stdio_env_var_names(env_vars)?;
    let mut env: HashMap<OsString, OsString> = DEFAULT_ENV_VARS
        .iter().copied().chain(additional_env_vars)
        .filter_map(|var| env::var_os(var).map(|value| (OsString::from(var), value)))
        .collect();
    ...
}
```

The child's env starts **empty** and is populated only from `DEFAULT_ENV_VARS` (Unix:
`HOME, LOGNAME, PATH, SHELL, USER, __CF_USER_TEXT_ENCODING, LANG, LC_ALL, TERM, TMPDIR, TZ`
— `utils.rs:163-173`) plus whatever the registration's `env_vars` list names. **`CODEX_HOME` is
not in `DEFAULT_ENV_VARS`.** So the old CLAUDE.md/CODEX-RESEARCH.md claim "the real Codex CLI
never forwards CODEX_HOME to the MCP subprocess" is accurate only for a registration that omits
`env_vars` — which is what a bare `codex mcp add ... -- npx ...` produces (its `--env` flag only
sets literal values, not a forwarding allowlist; there is no `--env-vars` CLI flag at all,
confirmed by `codex mcp add --help`). A plugin's `.mcp.json`/`.codex-plugin/mcp.json` (or a
manual `env_vars = [...]` line in `config.toml`) is the only way to request forwarding, which is
exactly what CX-4's remediation (this plugin's `"env_vars": ["CODEX_HOME"]`) does. This is also
why the local-only `codex mcp add` path in README needs a manual `config.toml` follow-up to get
the same forwarding the plugin gets for free.

There is no `sandbox: None`/no-sandbox-wrapper code path visible for the **local** launcher at
all (no sandbox parameter exists on that code path — `Command::new(...)` is spawned directly);
the remote/executor launcher explicitly passes `sandbox: None` in its `ExecParams`. Either way,
confirms the existing "Codex spawns MCP servers with no sandbox wrapper" claim for a local stdio
server (our case), now cited to real source instead of a missing file.

## 3. Live check (Step 3) — scratch `CODEX_HOME`, real `codex` binary, never touched `~/.codex`

`codex-cli 0.154.0`, `CODEX_HOME` pointed at a throwaway directory under this session's
scratchpad for the whole check.

```
$ codex plugin marketplace add <repo>
Added marketplace `predexec` from <repo>.
Installed marketplace root: <repo>

$ codex plugin list
PLUGIN             STATUS         VERSION  SOURCE
predexec@predexec  not installed           <repo>

$ codex plugin add predexec@predexec     # bare `codex plugin add predexec` errors:
                                          # "plugin requires --marketplace unless passed as <plugin>@<marketplace>"
Added plugin `predexec` from marketplace `predexec`.
Installed plugin root: $CODEX_HOME/plugins/cache/predexec/predexec/0.4.1

$ codex plugin list
PLUGIN             STATUS              VERSION  SOURCE
predexec@predexec  installed, enabled  0.4.1    <repo>

$ codex mcp list
Name      Command  Args                                                   Env               Cwd  Status   Auth
predexec  npx      -y --package=predexec@0.4.1 predexec-mcp --host codex  CODEX_HOME=*****  -    enabled  Unsupported

$ codex mcp get predexec --json
{
  "name": "predexec", "enabled": true, "disabled_reason": null,
  "transport": {
    "type": "stdio", "command": "npx",
    "args": ["-y", "--package=predexec@0.4.1", "predexec-mcp", "--host", "codex"],
    "env": null, "env_vars": ["CODEX_HOME"], "cwd": null
  },
  "enabled_tools": null, "disabled_tools": null,
  "startup_timeout_sec": null, "tool_timeout_sec": null
}
```

Results:

- Version resolved (`0.4.1`) matches `.codex-plugin/plugin.json`, confirming `path: "./"` in the
  marketplace entry landed on the repo root as `plugin_root`.
- `codex mcp add`'s CLI form takes a bare plugin name (`codex plugin add predexec`), but
  `codex plugin add` for a **plugin catalog entry** requires `<name>@<marketplace>` unless
  `--marketplace` is passed — README's install snippet uses `codex plugin add predexec` per the
  brief, which works once exactly one marketplace named `predexec` is registered (the ambiguous
  form only errors when a bare name is ambiguous across marketplaces or none is found); the
  form `predexec@predexec` is the unambiguous one and is what this record used.
- `env_vars: ["CODEX_HOME"]` round-tripped exactly through registration, confirmed both by
  `codex mcp get --json` and by `codex mcp list`'s masked `Env` column showing `CODEX_HOME=*****`
  — end-to-end proof that CX-4's fix works as intended.
- **Caveat, not a defect to fix here**: a `local`-source plugin install copies the **entire**
  source directory tree into `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/`,
  `node_modules` and all — confirmed by listing the installed cache dir. Harmless for
  correctness (skill/mcp resolution still only reads the paths the manifest names — verified: the
  cache directory does contain `skills/claude/` and `skills/opencode/` too, since the whole repo
  was copied, but per §1 Codex's own loader never looks at them), but worth knowing before
  recommending this install path for a much larger repo.
- Marketplace lookup order: Codex checks `MARKETPLACE_MANIFEST_RELATIVE_PATHS` in this fixed
  order — `.agents/plugins/marketplace.json`, `.agents/plugins/api_marketplace.json`,
  `.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json` — first match wins
  (`marketplace.rs:323-332`, `find_map`). Since this repo now ships `.agents/plugins/
  marketplace.json`, `codex plugin marketplace add` on this repo always resolves to *that* file
  and never even inspects `.claude-plugin/marketplace.json`, even though both exist side by side.
- Cleaned up after the check: `codex plugin marketplace remove predexec` (run against the same
  scratch `CODEX_HOME`; `~/.codex` was never referenced or modified by this check).

## 4. Antigravity interop (Controller ruling R5)

`agy` (Antigravity CLI, `~/.local/bin/agy`, `v1.2.10`) documents plugin discovery
(`~/.gemini/antigravity/builtin/skills/agy-customizations/docs/plugins.md`) as: "A plugin must be
contained within a **subdirectory** of a `plugins/` folder in a customization root (e.g.,
`.agents/plugins/`)" — each such subdirectory needs its own `plugin.json` marker file. Our
`.agents/plugins/marketplace.json` is a **file directly inside** `.agents/plugins/`, not a
subdirectory, so it does not match agy's plugin-discovery shape at all.

Verified directly with `agy plugin validate` (never touched a real `agy` workspace/config; run
against a disposable scratch directory only):

```
$ agy plugin validate .agents/plugins           # the plugins/ folder itself
Error: missing plugin.json: stat .../.agents/plugins/plugin.json: no such file or directory
$ agy plugin validate .agents/plugins/marketplace.json
Error: missing plugin.json: stat .../.agents/plugins/marketplace.json/plugin.json: not a directory
$ agy plugin validate .                          # repo root
Error: missing plugin.json: stat .../plugin.json: no such file or directory
```

`agy` cleanly refuses (exit 1, clear message) in every case — it never tries to interpret
`marketplace.json`'s contents as a plugin manifest, matching the docs' subdirectory-only
discovery rule. Conclusion: a Codex `.agents/plugins/marketplace.json` file is inert to agy;
no relocation needed.
