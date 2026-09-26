# Antigravity CLI (`agy`): live MCP spawn, approval, sandbox, skills, plugin namespacing

Measured 2026-09-26 on macOS (Darwin 25.5.0, arm64) with `agy` **1.2.11** (`agy --version`; the planning
notes said 1.2.10, but the installed binary reported 1.2.11 when measured), using the user's existing keyring login.
The probe is `scripts/probes/mcp-env-probe.mjs`, a stdio MCP server built on
`@modelcontextprotocol/server` with one tool, `probe`, annotated `readOnlyHint: true`. It is not
shipped: `scripts/` is outside `package.json` `files`, and `npm pack --dry-run` lists no
`scripts/` entry.

**Method constraint.** Nothing under `~/.gemini` was modified. There was no `agy mcp add`, no
`agy plugin install`, and no edits to `settings.json`/`config.json`/skills dirs;
`shasum -c` over `antigravity-cli/settings.json`, `config/config.json`, and `config/mcp_config.json`
passed after all runs. agy still writes its own conversation and state records under
`~/.gemini/antigravity-cli` whenever it runs. Everything was probed through a scratch workspace
(`git init`ed, under the session scratchpad):

```
agy-ws/
  .agents/mcp_config.json                     # workspace server "predexec-probe" (PROBE_SRC=workspace)
  .agents/skills/probe-ws-skill/SKILL.md
  .agents/plugins/probeplug/plugin.json       # {"name":"probeplug"}
  .agents/plugins/probeplug/mcp_config.json   # plugin server, ALSO named "predexec-probe" (PROBE_SRC=plugin)
  .agents/plugins/probeplug/skills/probe-plugin-skill/SKILL.md
  sub/deeper/                                 # cwd test
```

The server configs used an absolute `node` path and `env: {PROBE, PROBE_SRC, PROBE_LOG,
PROBE_WRITE_TARGET}`. Four model-backed prompt runs were used, each wrapped in a 120 s alarm.
`/skills`, `/config`, and `/permissions` print-mode runs cost no quota and are not counted.

Paths in the excerpts below are redacted: `~` stands for the home directory and
`.../scratchpad` or `<scratchpad>` for the session scratch directory. The raw values were absolute paths.

## Headless invocation that worked

```sh
cd <workspace-or-subdir>
agy -p "<prompt>" --output-format stream-json --log-file <scratch>/runN.log   # optionally --sandbox
```

- `-p/--print` runs one turn non-interactively. `--output-format stream-json` is the useful mode:
  it emits an `init` event (`cwd`, `permission_mode`, tool list) and a `step_update` per tool call
  with `tool_info.parameters` and raw `output`. `json` returns only the final text.
- `--log-file` gives language-server logs, including the child's parent pid, `workspaceDirs`,
  and the sandbox state.
- **A scratch workspace outside `trustedWorkspaces` still loaded its `.agents/` customizations
  (MCP servers, skills, plugins) in `-p` mode.** There was no trust prompt and no refusal.
- **Pitfall:** `agy -p "/skills"` (the free, quota-less slash-command listing) did **not** list
  the workspace or workspace-plugin skills, and it started no workspace MCP server. A real prompt
  turn in the same directory saw both. Do not use `/skills` output to test workspace discovery.
  `agy mcp list` likewise shows only the user-level `~/.gemini/config/mcp_config.json`.

## (a) Server cwd, and the subdir case: VERIFIED

**The workspace-configured MCP server's cwd is the directory agy was launched from, not the
workspace/git root.** agy treats the launch dir itself as the workspace (`workspaceDirs=[<cwd>]`)
and still discovers `.agents/` from the enclosing repo root.

Run 2, launched from `agy-ws/sub/deeper`:

```
run2.log: Creating CLI server backend: product=antigravity workspaceDirs=[.../scratchpad/agy-ws/sub/deeper] appDataDir=~/.gemini/antigravity-cli
tool_info: {"ServerName":"predexec-probe","ToolName":"probe"} output: {"pid":6890,"ppid":6791,"cwd":".../scratchpad/agy-ws/sub/deeper", ...}
```

Launched from the root (runs 1 and 3), the cwd was `.../scratchpad/agy-ws`.

**Plugin-bundled servers run with cwd = the plugin's own directory**, whatever the launch dir.
They also get an extra env var, `PLUGIN_ROOT`, set to that directory:

```
{"pid":8192,"ppid":8143,"cwd":".../agy-ws/.agents/plugins/probeplug", ...,
 "envValues":{..., "PLUGIN_ROOT":".../agy-ws/.agents/plugins/probeplug"}}
```

This matches the 1.2.x changelog: "MCP servers defined by plugins ... now resolve against the
plugin's own directory".

**Parent process:** in every run the child's `ppid` equals the pid of agy's language-server
subprocess (`run1.log: Starting language server process with pid 3670` ↔ probe `ppid 3670`;
6791 ↔ 6791; 8143 ↔ 8143).

**Env reaching the child:** agy's entire inherited environment passes through unchanged. A diff
of the probe's env-var names against the launching shell's showed nothing removed and nothing
added except the config's own `env` entries, plus `PLUGIN_ROOT` for plugin servers. **No
`ANTIGRAVITY_*` or `GEMINI_*` vars reach the child** (`envValues` held only the `PROBE*` keys).
So a predexec server under agy cannot detect its host from the environment; it would need a
`--host` flag, as with Codex. Caveat: agy was launched from a Claude Code shell here, so
`CLAUDECODE`/`CLAUDE_CODE_*` names were present in the inherited env. They came from the
launcher, not from agy.

**Implication for predexec:** `process.cwd()` is the user's launch dir, which can be a subdir.
Any containment or policy lookup that assumes cwd = project root, as the Claude Code adapter
does, would under agy root itself at the subdir. A plugin-shipped server gets its plugin dir
instead, which is never the project.

## (b) Approval under the default `toolPermission`, and `readOnlyHint`: UNVERIFIED

**Blocker:** this machine's `~/.gemini/antigravity-cli/settings.json` sets
`"toolPermission": "always-proceed"` (the `stream-json` `init` event reports
`"permission_mode":"always-proceed"`). The 1.2.x changelog says that mode "auto-approve[s] MCP
tool calls". Every probe call ran with no prompt, which says nothing about the default mode.
`toolPermission` and `permissions.{allow,ask,deny}` live only in that global file, and project
grants live in `~/.gemini/config/projects/<id>.json`, also global. There is no CLI flag for
either: `--mode` accepts only `accept-edits|plan`, and the binary warns that
`--mode %s is not supported in print mode`. Changing the setting would mean editing global
state, which R47 forbids. The one override that exists, `JETSKI_APP_DATA_DIR`, was ignored
(the log still said `CLI app data directory: ~/.gemini/antigravity-cli`).
`HOME=<scratch>` relocates all of `~/.gemini`, but it breaks auth: the keyring login is not
found (`Error: authentication timed out.`).

**Evidence that does exist:**
- The binary parses MCP annotations. Its strings include `json:"readOnlyHint,omitempty"`,
  `destructiveHint`, and `(*ToolAnnotations).GetReadOnlyHint` in the
  `cloud/code/v1internal` proto, so the hint is at least read and forwarded. Its effect on
  approval is not observable here.
- The model never sees MCP tools as individual tools. The `init` tool list has a single
  dispatcher, `call_mcp_tool`, with `{ServerName, ToolName, Arguments}`, next to
  `ask_permission`/`ask_custom_permission`. Approval is decided per `call_mcp_tool` step.
- The changelog says `-p` treats "permission denials" as benign tool errors, not fatal exits. A
  headless run under `request-review` would therefore likely report a denied call rather than
  hang. This is not measured.

**To close it:** on a machine or account whose settings can be edited, set
`toolPermission: "request-review"` and repeat run 1 twice, once with the probe as-is and once
with `annotations` removed.

## (c) Do MCP children run outside the sandbox? VERIFIED: yes, outside

The terminal sandbox can be toggled per session with the `--sandbox` flag, so no global edit is
needed. Run 3, `agy --sandbox -p ...` from the workspace root:

```
run3.log: Print mode: enabling terminal sandbox for this session
call_mcp_tool predexec-probe → {"cwd":".../agy-ws","write":{"target":"~/predexec-probe-write-test-ws","ok":true},
                                "callWrite":{"target":"~/predexec-probe-write-test-ws","ok":true}, ...}
call_mcp_tool probeplug_predexec-probe → {"write":{"target":"~/predexec-probe-write-test-plugin","ok":true},
                                "callWrite":{... "ok":true}, ...}
run_command "touch ~/predexec-sbx-shell-test; echo EXIT=$?"
   → "touch: ~/predexec-sbx-shell-test: Operation not permitted\r\nEXIT=1"
```

In the same session, with the sandbox confirmed on, the agent's own shell could not write to
`$HOME`. Both MCP children (workspace and plugin) wrote to `$HOME` at spawn and again at call
time. **MCP servers are spawned by the language server outside the terminal sandbox**, the same
class of result as Codex (see CLAUDE.md, "Codex runs MCP servers OUTSIDE its sandbox"). Without
`--sandbox` (runs 1, 2, 4; `enableTerminalSandbox: false` in `/config`), the children's writes
also succeeded.

Implication: under agy, predexec's own read-only invariant, `destructive.ts`, and whatever policy
adapter gets written are the only barrier between a plan and the filesystem. agy's sandbox does
not contain the MCP subprocess.

(One run-2 record shows `"ok":false, ENOENT ... unlink`. Both probes shared one write target and
started at the same instant, so one deleted the other's file. That is a probe artifact, not a
sandbox effect, and runs 3 and 4 used a distinct target per server. No probe file was left in
`$HOME`.)

## (d) Which global skills dir is loaded: UNVERIFIED (strong static evidence for `~/.gemini/config/skills/`)

**Blocker:** answering this means placing a skill in `~/.gemini/config/skills/` and
`~/.gemini/antigravity-cli/skills/`, both global, which R47 forbids. No config-dir override
works with auth: `JETSKI_APP_DATA_DIR` is ignored, `HOME=<scratch>` loses the keyring login, and
the only `GeminiDir` knob is internal (log: `Failed to resolve GeminiDir ".gemini": .gemini must
be an absolute path ... falling back to default`, with no flag in `agy --help`). Workspace skills
were verified instead: `.agents/skills/probe-ws-skill` and the workspace plugin's
`probe-plugin-skill` were both reported by the model in run 1.

**Static evidence:**
- The built-in `migrate-workflows` skill
  (`~/.gemini/antigravity-cli/builtin/skills/migrate-workflows/SKILL.md`) names the global
  migration target as `~/.gemini/config/skills/<name>/SKILL.md` (the workspace target is
  `<workspace>/.agents/skills/<name>/SKILL.md`). The same table is embedded in the binary.
- `strings agy` contains `~/.gemini/config/skills/<name>/` and **no occurrence of
  `antigravity-cli/skills`**. The only `antigravity-cli/` skills path in use is the read-only
  built-in dir, `~/.gemini/antigravity-cli/builtin/skills/` (`/skills --output-format json`
  reports `"builtin": true` paths there).
- The `/skills` JSON reports plugin skills from `~/.gemini/config/plugins/<plugin>/skills/...`,
  so everything user-authored lives under `~/.gemini/config/`.

The best-supported answer is `~/.gemini/config/skills/`. It stays unverified until someone
runs this on a machine where `~/.gemini` can be edited:

```sh
mkdir -p ~/.gemini/config/skills/probe-config-skill ~/.gemini/antigravity-cli/skills/probe-cli-skill
printf -- '---\nname: probe-config-skill\ndescription: Probe skill. Never use.\n---\n# probe\n' \
  > ~/.gemini/config/skills/probe-config-skill/SKILL.md
printf -- '---\nname: probe-cli-skill\ndescription: Probe skill. Never use.\n---\n# probe\n' \
  > ~/.gemini/antigravity-cli/skills/probe-cli-skill/SKILL.md
# 1) free listing: it showed global PLUGIN skills with their path (workspace skills were absent)
agy -p "/skills" --output-format json | jq -r '.command.data.skills[] | "\(.name)\t\(.path)"' | grep probe-
# 2) one real turn, in case the listing and the agent's view differ
cd <any-git-repo> && agy -p "List every skill whose name starts with probe- (or say NONE). Do nothing else." \
  --output-format json | jq -r .response
rm -rf ~/.gemini/config/skills/probe-config-skill ~/.gemini/antigravity-cli/skills/probe-cli-skill
```

Whichever of `probe-config-skill` and `probe-cli-skill` appears is the directory that gets loaded.

## (e) Plugin tool namespacing, and whether `mcp(predexec-probe/*)` matches: namespacing VERIFIED, grant matching UNVERIFIED

This was measured with a **workspace** plugin (`.agents/plugins/probeplug/`), which the docs
treat as equivalent to an installed one ("A plugin must be contained within a subdirectory of a
`plugins/` folder in a customization root (e.g., `.agents/plugins/`)"). `agy plugin install`
was not run, because it writes the global plugin dir.

**A plugin's MCP server is renamed `<plugin>_<server>` unconditionally, collision or not.**
- Runs 1–3 had a same-named workspace server, so both were visible: `ServerName:"predexec-probe"`
  and `ServerName:"probeplug_predexec-probe"`.
- Run 4 parked the workspace `mcp_config.json`, leaving no collision. The plugin server was
  still `{"ServerName":"probeplug_predexec-probe","ToolName":"probe"}`.
- The tool name is unchanged (`probe`). Only the server segment is prefixed.
- Changelog: "automatically namespacing plugin MCP servers as `<plugin>_<server>`".
  (`docs/mcp_servers.md` says "if necessary". Measurement says always.)

**Grant matching is UNVERIFIED.** Testing whether `mcp(predexec-probe/*)` matches, or whether
`mcp(probeplug_predexec-probe/*)` is required, needs `permissions.allow/deny` entries in the
global `settings.json`, and the machine is in `always-proceed` anyway (see (b)). The grant
syntax is `mcp(server/tool)`, and the only server identity the runtime ever shows is the
prefixed `ServerName`. **Expect a plugin-shipped predexec (plugin `predexec`, server `predexec`)
to need `mcp(predexec_predexec/predexec)` or `mcp(predexec_predexec/*)`, not `mcp(predexec/*)`.
This is inferred, not measured.**

**To close grant matching,** on a machine where `~/.gemini` can be edited, use a scratch git
workspace containing only `.agents/plugins/probeplug/` (as above, with no workspace
`mcp_config.json`, so that only `probeplug_predexec-probe` exists):

```sh
cp ~/.gemini/antigravity-cli/settings.json <scratchpad>/settings.json.bak
# A: short-name grant
jq '.toolPermission="request-review" | .permissions.allow=["mcp(predexec-probe/*)"]' \
  <scratchpad>/settings.json.bak > ~/.gemini/antigravity-cli/settings.json
cd <scratch-ws> && agy -p "Call the MCP tool probe once, no arguments, and print its raw output." \
  --output-format stream-json | jq -c 'select(.step_update.step_type=="tool") | .step_update | {state, tool_info}'
# B: namespaced grant
jq '.toolPermission="request-review" | .permissions.allow=["mcp(probeplug_predexec-probe/*)"]' \
  <scratchpad>/settings.json.bak > ~/.gemini/antigravity-cli/settings.json
cd <scratch-ws> && agy -p "Call the MCP tool probe once, no arguments, and print its raw output." \
  --output-format stream-json | jq -c 'select(.step_update.step_type=="tool") | .step_update | {state, tool_info}'
cp <scratchpad>/settings.json.bak ~/.gemini/antigravity-cli/settings.json
```

A grant matches when its run shows a `call_mcp_tool` step that reaches `DONE` with the probe's
JSON as `output`. A grant does not match when the run shows a denial or permission-request step
instead. Run (b)'s ungranted `request-review` baseline first, so it is known what "not granted"
looks like in headless mode.

## Summary

| Question | Result |
|---|---|
| Headless flag | VERIFIED: `agy -p "<prompt>" --output-format stream-json [--sandbox] [--log-file F]` |
| (a) workspace server cwd | VERIFIED: the **launch dir** (subdir stays subdir); plugin server cwd = plugin dir |
| env into child | VERIFIED: full inherited env plus config `env`; `PLUGIN_ROOT` for plugin servers; no `ANTIGRAVITY_*`/`GEMINI_*` |
| parent | VERIFIED: agy's language-server subprocess |
| (b) default-mode approval / `readOnlyHint` | UNVERIFIED: global `always-proceed`, no non-global override |
| (c) child writes outside workspace | VERIFIED: yes, **even with `--sandbox`** (shell write blocked in the same session) |
| (d) global skills dir | UNVERIFIED: static evidence says `~/.gemini/config/skills/` |
| (e) plugin namespacing | VERIFIED: `<plugin>_<server>`, always; grant matching UNVERIFIED |
| untrusted workspace | VERIFIED: `.agents/` customizations load in `-p` mode without trust |
