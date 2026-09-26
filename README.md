# predexec

**Predictive execution** for LLM coding agents. predexec collapses an adaptive, multi-level
tool sequence into a **single model round-trip**: the model pre-compiles its branch decisions
into a tree of deterministic predicates, and an engine walks the tree with **no model call
between levels**. On a request-limited free provider this trades abundant tokens for scarce
provider requests.

This package ships four adapters, each registering one tool, `predexec`:
a [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension,
an [opencode](https://opencode.ai) plugin, a
[Claude Code](https://code.claude.com/docs/en/overview) MCP server, and a
[Codex CLI](https://github.com/openai/codex) MCP server — the same stdio server as Claude
Code's, started with `--host codex` to select Codex's policy reader and stats label.
See [How it works](#how-it-works) below for the design and current status.

> **Status: read-only.** The pure-TS core and all four adapters are done and unit-tested.
> predexec speculates **read-only only** — any write/install/delete hard-stops before running.

## How it works

The model fills in a **plan tree**: each node runs a batch of shell commands and/or read-only
tool calls (`read`/`grep`/`find`/`ls`); each edge is a machine-evaluable **condition** on that
node's output. After running a node, the engine
evaluates outgoing edges in order, follows the first match to a child, and repeats — with no
model in the loop. It stops and returns a transcript when it reaches:

| stop | meaning |
|---|---|
| `leaf` | no edges — success path complete (the only non-fallback stop) |
| `noEdgeMatch` | no edge matched — benign miss, agent resumes normally |
| `maxDepth` | depth cap hit |
| `mutationStop` | next node writes/installs/deletes — **hard stop before any mutation** |
| `error` | invalid plan (returned gracefully, never thrown) |
| `aborted` | abort signal |

**Adaptive depth.** Plan as deep as you can *confidently* predict each branch. A tree of one
node with no edges is valid and expected — that's just running a command (depth 0). Depth scales
up only when branches are genuinely predictable.

### Condition DSL (confidence-tiered)

HIGH-confidence (may gate deeper speculation): `exitCode`, `fileExists`, `jsonPath`, `numeric`,
`always`. LOW-confidence (may branch only to a read-only node): `match` (regex over stdout/stderr).

## Harness support

How completely predexec's design survives contact with each harness. The score is **fit**, not
quality of the harness — it drops when predexec has to reimplement or approximate something the
design wants to get natively.

| | **pi** | **opencode** | **Claude Code** | **Codex** |
| :-- | :-- | :-- | :-- | :-- |
| Integration | in-process extension | in-process plugin | out-of-process **stdio MCP** | out-of-process **stdio MCP** (same server as Claude Code) |
| Tool registration | native (`pi.extensions`) | native (`plugin` array) | MCP tool — the only route CC offers a third party | MCP tool — the only route Codex offers a third party |
| `read`/`grep`/`find`/`ls` | the host's **own tool factories** — exact parity | host SDK, with real caps | **own implementation** over `node:fs` (`rg`/`fd` accelerate) | same implementation as Claude Code (`mcp/tool-ops.ts` is shared) |
| Steering | skill auto-loaded via `pi.skills` | guarded system-prompt push, or `AGENTS.md` | skill via plugin wrapper + tool description | `AGENTS.md` native (no plugin wrapper needed) + tool description |
| Streaming progress | yes (`onUpdate`) | no | no | no |
| Host permission rules | n/a — pi has no per-command rules (project-trust only) | **self-checked** from `permission.bash` plus supported native `read`/`grep`/`glob` rules (with local `list` compatibility), last-match-wins | **self-enforced** from `settings.json`, including mapped native read/search operations via supported `Read`/`Grep`/`Glob` rules (host rules don't reach a subprocess) | **self-enforced** from persisted `config.toml` + execpolicy rules for shell/Bash only — no persisted native file-operation source and **no OS sandbox backstop** (MCP servers run outside it entirely, measured) |
| Published format | compiled ESM (`dist/`) | compiled ESM (`dist/`) | compiled ESM (`dist/`) | compiled ESM (`dist/`) |
| **Fit** | **9 / 10** | **7 / 10** | **6 / 10** | **5 / 10** |

**pi — 9.** Everything the design wants exists natively: predexec borrows pi's real tool
implementations, so a plan's `read` is *the* `read`; the routing skill auto-registers; progress
streams. Nothing is approximated. The missing point is not predexec's doing — pi has no
per-command permission model to honor, so the mutation hard-stop is the only guard, and pi ships
no sandbox.

**opencode — 7.** Native tool registration and a real permission model predexec enforces. Points
lost to measured SDK limits that predexec can only report, not fix: grep is **hard-capped at 10
matches** server-side, `file.read` has no offset/limit and returns trimmed content, and `find` is
fuzzy where pi's is glob-based. An npm-installed plugin also can't auto-register a skill, so
steering falls back to a guarded system-prompt push. In addition to Bash, predexec self-checks
supported native `read`, `grep`, and `glob` permissions (with the repository's legacy `list`
compatibility shape retained).

**Claude Code — 6.** It works, and MCP is the only door — but out-of-process costs are real.
There are no host tool factories, so `mcp/tool-ops.ts` is a second implementation of
read/grep/find/ls with its own behavior (`.gitignore` handling, regex dialect, output format).
Your `Bash(...)` rules don't reach the subprocess, so predexec re-reads and enforces them
itself. No streaming progress. What it does keep is the thing that matters: the same `core/`
engine, the same plan tree, the same hard-stops.

**Codex — 5.** Literally the same `mcp/server.ts` and `mcp/tool-ops.ts` as Claude Code (started
with `--host codex`), so the same out-of-process costs apply: a second read/grep/find/ls
implementation, no streaming. Two things make the fit worse than Claude Code's slot. First,
Codex spawns MCP servers **entirely outside its own sandbox** — measured directly, not
inferred: a probe server wrote to disk with zero error while the session's own shell tool was
confined to a `read-only` sandbox — so there is no OS-level backstop at all, only
`mcp/policy-codex.ts`'s `config.toml`/execpolicy-rules reading and predexec's own
`destructive.ts` heuristic (see the sandbox warning under [Codex CLI](#codex-cli) below).
Its persisted policy checker is intentionally shell/Bash-only: Codex has no persisted native
file-operation rule source for predexec to mirror, so native read/search operations continue
through predexec's own read-only and containment guards.
Second, Codex's default per-call approval mode treats an *unannotated* tool as destructive, so
declaring `readOnlyHint: true` is load-bearing just to run a plan without a prompt under
default settings (per Codex's source), not merely a nicety. What's better here: Codex now
supports both a self-hosting plugin (`.codex-plugin/`, `.agents/plugins/marketplace.json` — see
[Codex CLI](#codex-cli) below) *and* a native `AGENTS.md` fallback that needs no plugin wrapper
at all, unlike Claude Code, which has only the MCP/plugin route.

## Install

### pi coding agent

```bash
pi install npm:predexec
```

That's the whole install. pi fetches the package from npm, runs `npm install --omit=dev`,
and registers the `predexec` tool from the package's
`pi.extensions` manifest (plus a terse routing skill from `pi.skills`,
`.pi/skills/predexec/SKILL.md`) — runs compiled ESM from `dist/`. Once pi
starts, the model routes multi-step work through it on its own.

```bash
pi -e npm:predexec                   # try it for one run, no settings change
pi remove npm:predexec               # uninstall
pi update --extensions               # update installed packages
```

**Verify:**

```bash
pi list                              # must show npm:predexec and its install path
npx -y predexec doctor               # install checks: [x] green, [!] broken, [ ] not wired
```

Then start `pi` and try the prompt under [A prompt to see it work](#a-prompt-to-see-it-work) —
the tool result's `details` (`pathTaken`, `stoppedReason`) confirm the engine actually walked
a plan tree.

To install from the git repo HEAD instead of the published npm release:

```bash
pi install git:github.com/FuriousZen/predexec
```

**Prerequisites:** Node 22+ and the pi coding agent on PATH (`npm i -g
@earendil-works/pi-coding-agent`), authenticated for some provider. The simplest way is an env
var — pi auto-detects provider keys from the environment (`OPENCODE_API_KEY`, `NVIDIA_API_KEY`,
`OPENROUTER_API_KEY`, …), so no `~/.pi` editing is required.

### opencode

Add predexec to your `opencode.json` (project root, or `~/.config/opencode/opencode.json` for global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["predexec"]
}
```

That's the whole install — opencode resolves the plugin from npm, loads `dist/.opencode/plugins/predexec.js`
in-process via Bun, and registers the `predexec` tool natively. No global install, no wrapper file.
Restart opencode after editing.

To **update**, note that `"predexec@latest"` does not re-resolve on its own: opencode caches the
package in a directory literally named `predexec@latest` and reuses it across restarts. Clear the
cache first:

```bash
rm -rf ~/.cache/opencode/packages/predexec@latest   # then restart opencode
```

**Verify** (no model request needed):

```bash
npx -y predexec doctor               # static install checks
npx -y predexec doctor --live        # live probe: spawns opencode, confirms tool registered
opencode serve --port 4599 &
curl -s localhost:4599/experimental/tool/ids   # must include "predexec"
```

If `predexec` is missing from the list, the plugin was **silently skipped** — opencode surfaces
plugin load failures only as internal session events, so this curl is the reliable check.
Then, in a session, try the prompt under [A prompt to see it work](#a-prompt-to-see-it-work).

The plugin ships its own routing skill (`skills/opencode/predexec/SKILL.md`) automatically:
its `config` hook appends the packaged skill directory's absolute path to `skills.paths`
on opencode's live config object, so `predexec` shows up in the model's skill list with no
`install-skill` step. It also injects a one-line routing rule into the system prompt as a
**guarded fallback**, for an agent whose `tools.skill:false` or a `permission.skill` deny
rule hides skills entirely, or for a host/version where the config hook doesn't take effect
(see `docs/research/opencode-skills.md`).

To steer declaratively instead — or as a fallback for either case above — copy the routing
block into your project's `AGENTS.md`:

```bash
curl -fsSL https://raw.githubusercontent.com/FuriousZen/predexec/main/configs/opencode/AGENTS.md -o AGENTS.md
```

(A plugin install has no project `node_modules` — opencode keeps the package in its own
cache — so fetch the block from the repo, or `cp configs/opencode/AGENTS.md` from a clone.)

When opencode loads that natively, the plugin detects it (a quorum of routing-rule markers,
not a mere mention of the name) and skips its own injection — no duplication.

For local development, opencode also auto-discovers `.opencode/plugins/*.ts`, so running opencode
**inside a clone of this repo** picks up `.opencode/plugins/predexec.ts` directly.

**Prerequisites:** the [opencode](https://opencode.ai) CLI installed and authenticated for some
provider.

predexec's payoff is largest on a request-limited free tier (OpenCode Zen free models, NVIDIA
NIM, OpenRouter free).

> **Using the devcontainer?** It lives in the *parent* directory of this repo, not inside it, so
> a plain `git clone` of predexec does not bring it along. Where it is present, `post-create`
> auto-installs predexec on every rebuild and `.devcontainer/.env` supplies the provider keys.

### Claude Code

Claude Code has no in-process tool-registration API for third parties — a plugin ships skills,
agents, hooks, MCP servers and LSP servers, but cannot register a *tool*. So predexec reaches
Claude Code as a small **stdio MCP server** exposing the same single `predexec` tool, backed by
the same `core/` engine as the other two adapters.

**Install as a plugin (recommended):**

```bash
/plugin marketplace add FuriousZen/predexec
/plugin install predexec@predexec
```

This installs the version-pinned MCP server *and* the routing skill together, both declared in
`.claude-plugin/plugin.json` / `marketplace.json` — no separate skill-install step.

**Verify:**

```bash
claude plugin list       # predexec@predexec → ✔ enabled
npx -y predexec doctor   # shows the plugin install and its bundled skill
```

**Alternative: MCP server only, no plugin.** Skips the marketplace entirely:

```bash
claude mcp add predexec -- npx -y --package=predexec predexec-mcp
npx -y predexec install-skill claude
```

Use `--scope project` to share the server with a repo (writes `.mcp.json`, which each
collaborator approves once), or `--scope user` for every project on the machine.
`install-skill claude` copies the routing skill in separately, since this path has no plugin
manifest to bundle it.

```bash
claude mcp list          # predexec → ✔ Connected
npx -y predexec doctor   # shows the registered scope, and flags "awaiting approval"
```

> **Don't do both.** The plugin's `.claude-plugin/plugin.json` already inlines the same MCP
> server; also running `claude mcp add` registers a second `predexec` server that competes with
> the plugin's for the same tool name. Pick one install path.

Then try the prompt under [A prompt to see it work](#a-prompt-to-see-it-work).

#### Permissions — read this one

An MCP server is a **separate process**, so the shell commands predexec runs inside it are *not*
filtered by your Claude Code `Bash(...)` allow/ask/deny rules. Anthropic documents this directly:
deny rules "don't apply to arbitrary subprocesses that read or write files indirectly."

predexec therefore enforces your rules itself: it reads your settings (managed →
`.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`) and
**hard-stops before running anything a `deny` *or* `ask` rule would have caught** — it cannot
prompt mid-walk, so it stops instead. predexec is always at least as strict as the host, never
less. Two limits worth knowing:

- `--allowedTools` / `--disallowedTools` passed on the CLI are invisible to a subprocess and
  cannot be honored. Put rules you rely on in a settings file.
- predexec's MCP `read`/`grep`/`find`/`ls` operations are self-checked against the supported
  `Read(...)`, `Grep(...)`, and `Glob(...)` rules in Claude settings. Unsupported Claude
  permission shapes and CLI-only flags cannot be mirrored by the subprocess. For OS-level
  enforcement that binds every process, enable
  [sandboxing](https://code.claude.com/docs/en/sandboxing).

MCP `read`/`grep`/`find`/`ls` paths are checked after symlink resolution and cannot leave the
session root; dependency symlinks below an exact `node_modules` path segment are the sole
exception.

Native operation limits are bounded before execution: `read` accepts at most 10,000 lines,
`grep`/`find` at most 1,000 results, `ls` at most 5,000 entries, `grep` patterns at most
8,192 characters, and `grep` context at most 100 lines per side. Limits and offsets are positive
integers; omitted values keep adapter defaults.

The MCP adapter revalidates canonical paths at operation boundaries, post-validates search result
paths, uses stable directory handles for local walks/listings, and opens files with `O_NOFOLLOW`
where the platform exposes that flag. Node does not provide a portable `openat`/`readdirat`
traversal API, so a malicious concurrent rename/replacement of a parent directory can still
race a pathname-based open or an `rg`/`fd` accelerator; this is outside the adapter's
single-process threat model.

#### Plugin form, in detail

The repo is itself a self-hosting Claude Code plugin *and* marketplace: `.claude-plugin/
plugin.json` bundles the MCP server with the routing skill (`skills` → `./skills/claude/`), and
`.claude-plugin/marketplace.json` lists that same plugin with `source: "./"` — one repo, one
`git clone`/`add` away from an install by name. The server config is **inlined** in the manifest
rather than kept in a root `.mcp.json` — a root `.mcp.json` is a live project-scope registration,
so it would prompt anyone who merely opened this repo in Claude Code. It shells out to the same
version-pinned `npx` command rather than vendoring `node_modules`, so there is no
dependency-bundling step; `scripts/sync-plugin-version.mjs` keeps both manifests' `version` and
the npx `--package=predexec@…` pin in step with `package.json` on every `npm version`.

### Codex CLI

Codex has no in-process tool-registration API either, so predexec reaches it the same way it
reaches Claude Code: the identical stdio MCP server, `mcp/server.ts`. Only the policy reader and
stats label differ, and — because Codex clears every `CODEX_*` env var before spawning the
subprocess (measured; there is no equivalent of `CLAUDE_PROJECT_DIR`), so the server cannot
detect its host on its own — they're selected explicitly with a flag: `--host codex`.

**Install as a plugin (recommended):**

```bash
codex plugin marketplace add FuriousZen/predexec
codex plugin add predexec@predexec
```

This installs the version-pinned MCP server *and* the routing skill together, both declared in
`.codex-plugin/plugin.json` / `.agents/plugins/marketplace.json` — no separate skill-install step.
The plugin's MCP registration also forwards `CODEX_HOME` into the subprocess
(`env_vars: ["CODEX_HOME"]`) — a bare `codex mcp add` cannot do this (see the sandbox note below).

**Verify:**

```bash
codex mcp list           # predexec → enabled, Env column shows CODEX_HOME=*****
npx -y predexec doctor   # shows the plugin install and its bundled skill
```

**Alternative: MCP server only, no plugin.** Skips the marketplace entirely:

```bash
codex mcp add predexec -- npx -y --package=predexec predexec-mcp --host codex
npx -y predexec install-skill codex
```

`codex mcp add` registers **globally** (`~/.codex/config.toml`) — there's no per-project scope
flag the way Claude Code has `--scope project`. This path has no manifest to request env
forwarding, so if your shell sets a custom `CODEX_HOME`, add it by hand (`npx -y predexec doctor`
flags a registration that's missing this):

```toml
[mcp_servers.predexec]
env_vars = ["CODEX_HOME"]
```

`install-skill codex` copies the routing skill in separately, since this path has no plugin
manifest to bundle it.

**Verify:**

```bash
codex mcp get predexec --json    # transport.command/args populated, "enabled": true
npx -y predexec doctor           # shows the registered scope, flags a broken install
```

**Timeouts.** `startup_timeout_sec` / `tool_timeout_sec` defaults are version-dependent (the
docs say 10s/60s, the source at the time of writing says 30s/300s) — a long plan tree is safer
with an explicit value. Add it to `~/.codex/config.toml`:

```toml
[mcp_servers.predexec]
command = "npx"
args = ["-y", "--package=predexec", "predexec-mcp", "--host", "codex"]
env_vars = ["CODEX_HOME"]
tool_timeout_sec = 120
```

**Fallback: `AGENTS.md`, no MCP tool at all.** Only useful when you can't register an MCP server
— this steers Codex's *prose*, it registers no tool and bundles no skill. Codex loads a project's
`AGENTS.md` natively and concatenates it (repo root down to your working directory) under a
32 KiB combined cap, so append to an existing file rather than clobbering it:

```bash
curl -fsSL https://raw.githubusercontent.com/FuriousZen/predexec/main/configs/codex/AGENTS.md >> AGENTS.md
```

`configs/codex/AGENTS.md` ships paste-ready (no install commentary in the file itself), so
appending it straight into an existing `AGENTS.md` — or a fresh one — works either way; keep the
block as shipped rather than padding it.

#### Sandbox — read this one

> **Codex runs MCP servers OUTSIDE its sandbox.** Measured directly: under a `read-only`
> session sandbox, a throwaway probe MCP server still wrote a log line to disk with zero
> error — the child process was never inside Seatbelt (macOS) / Landlock+bwrap (Linux) at all.
> **Every shell command a predexec plan runs bypasses Codex's sandbox entirely**, regardless of
> `sandbox_mode` / the active permission profile, because those govern Codex's *own* shell tool,
> not an MCP subprocess. predexec's read-only invariant, the `destructive.ts` heuristic, and the
> fail-closed execpolicy-rules adapter (reads `~/.codex/config.toml` plus
> `~/.codex/rules/*.rules` / `<repo>/.codex/rules/`) are the **only** containment — there is no
> OS-level backstop the way Claude Code's sandboxing docs offer. Session-only CLI flags
> (`--sandbox`, `-a`/`--ask-for-approval`, `--profile`, `--full-auto`) are a config layer that
> never touches disk, so predexec cannot see or honor them either — parallel to Claude Code's
> `--allowedTools` gap, except here nothing else is watching. This is not a defect predexec can
> fix; it is how Codex spawns MCP servers, and it means every predexec-run command deserves the
> same trust you'd give a command Codex's sandbox wasn't guarding at all.
>
> predexec also declares `readOnlyHint: true` on its tool so Codex's per-call approval flow
> (default `auto`, which otherwise treats an *unannotated* tool as destructive and prompts every
> call) runs plans without a prompt. That's an approval-UX convenience, not a sandbox, and
> changes nothing above.
>
> One more asymmetry worth knowing: Codex pipes MCP server stderr into its own log store, not
> the TUI. On the build this was verified against (0.149.1), a deliberately written stderr line
> did not surface in either the documented log location or its replacement — treat stderr as
> unrecoverable and rely on the tool's own text result, never diagnostic logging, when a plan
> fails.

### Antigravity CLI (`agy`)

The same stdio MCP server, started with `--host antigravity`. agy passes no host marker in the
subprocess env (measured), so the flag is required. It selects the Antigravity policy reader
(`mcp/policy-antigravity.ts`) and the `antigravity` stats label.

**Session root.** agy starts a workspace MCP server in the directory `agy` was launched from,
which may be a subdirectory. It starts a plugin server in the plugin's own directory, with
`PLUGIN_ROOT` set (both measured). predexec therefore resolves its root in this order:

1. `--root <dir>` in the server args, or `PREDEXEC_ROOT=<dir>` in the server env.
2. If running as a plugin server (cwd == `PLUGIN_ROOT`) with neither set: every plan fails
   with an error telling you to set one. The plugin directory is never used as the workspace.
3. Otherwise, the nearest ancestor of the launch dir that contains `.git` or `.agents`.
4. Otherwise, the launch dir itself.

`--root` is rejected with any other `--host`.

**Permissions.** Grants are read from `~/.gemini/antigravity-cli/settings.json`
(`permissions.{deny,ask,allow}`, `toolPermission`, `allowNonWorkspaceAccess`), per
<https://antigravity.google/docs/permissions>. Shell commands are checked against `command(...)`
grants and read/grep/find/ls against `read_file(...)` grants, with Deny > Ask > Allow. A deny or
ask match hard-stops the walk. Under `toolPermission: "strict"` (or an unknown mode), an
operation stops unless an allow grant covers it. `allowNonWorkspaceAccess: false` stops tool ops
that reach outside the workspace. A settings file that will not parse stops everything. So does
a deny/ask grant predexec cannot evaluate, such as an unknown syntax or a `regex:` that could
backtrack catastrophically. Grants made in the app/IDE UI and per-project grants are not
readable and are not applied. agy runs MCP servers outside its terminal sandbox, even with
`--sandbox` (measured), so, as with Codex, this policy check and predexec's read-only
enforcement are the only containment.

### A prompt to see it work

A read-only, structurally predictable task — predexec's sweet spot:

```
Detect this project's package manager and run its test script.
```

The model can plan one tree: probe for a lockfile / read `package.json` scripts, branch on
what it finds (`fileExists pnpm-lock.yaml`, `jsonPath scripts.test exists`), and run the right
test command — resolving several branch points in a single round-trip instead of one model
call per step. On pi and opencode, inspect the tool result's `details` (`depthReached`,
`pathTaken`, `stoppedReason`, `edgesEvaluated`/`edgesMatched`) to see the path the engine
walked. The Claude Code MCP adapter returns only the transcript text to the model — `details`
never reaches it there — so on Claude Code, check the transcript and run `npx -y predexec
stats` for the same accounting.

## Doctor & stats

predexec ships a CLI (`bin/predexec.mjs`, node builtins only) for install diagnostics and
request accounting:

```bash
npx -y predexec doctor              # node version + pi / opencode / Claude Code / Codex wiring + skill checks
npx -y predexec doctor --live       # + spawns opencode and probes tool registration
npx -y predexec stats               # aggregate recorded runs: ops collapsed, requests saved, edge hit-rate
npx -y predexec install-skill <claude|codex|opencode|antigravity|pi> [--project] [--dry-run] [--force]
```

`doctor` reports four states and **exits non-zero only for `[!]`** — a machine that simply
doesn't use a given harness is healthy, not broken:

| | meaning |
| :-- | :-- |
| `[x]` | wired and healthy |
| `[!]` | predexec IS wired here but is broken — the only state that fails |
| `[ ]` | harness installed, predexec not wired (actionable) |
| `[-]` | harness not installed |

Alongside each MCP/plugin registration check, `doctor` also looks for the harness's own routing
`SKILL.md` in that host's documented skill-discovery locations: `[x]` when found (or bundled with
the Claude Code plugin form), `[ ]` with an `install-skill` hint when the harness is registered but
no skill is visible, `[!]` when **two different** predexec skills are visible to the same host
(e.g. opencode also scans `.claude/skills`, so a stale Claude-flavored copy left there conflicts
with opencode's own), and an `info` note when a project's `AGENTS.md` routing block and an
installed skill are both active (harmless — the routing text just loads twice). Identical
duplicate copies of the same skill across two discovery roots are `info`, not `[!]`.

`install-skill` copies the packaged skill for one harness into that host's own skill directory
(pi needs no such step — it loads the skill straight out of the installed package; opencode
needs no such step either — its plugin registers the packaged skill itself via a `config`
hook, so `install-skill opencode` is a manual fallback for hosts where that doesn't apply):

| harness | `--project` off (global) | `--project` |
| :-- | :-- | :-- |
| claude | `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/predexec/` | `.claude/skills/predexec/` |
| codex | `~/.agents/skills/predexec/` | `.agents/skills/predexec/` |
| opencode | `~/.config/opencode/skills/predexec/` | `.opencode/skills/predexec/` |
| antigravity | `~/.gemini/config/skills/predexec/` (provisional) | `.agents/skills/predexec/` |

It refuses to overwrite a destination file whose content differs from the packaged one unless
`--force` is given, and `--dry-run` prints what it would do without touching disk.

Stats are append-only JSONL in `$PREDEXEC_STATE_DIR` (or `$XDG_STATE_HOME/predexec`, or
`~/.local/state/predexec`). Each adapter calls `recordRun` after every `runPlanTree` — fire-and-forget,
errors swallowed (a stats failure must never break a tool call).

## Develop / contribute

Clone and use pnpm (the project's package manager):

```bash
git clone https://github.com/FuriousZen/predexec && cd predexec
corepack enable     # makes pnpm available (ships with Node)
pnpm install
pnpm run build      # tsc -p tsconfig.build.json -> dist/
pnpm test           # vitest
pnpm run typecheck  # tsc --noEmit
```

Load your working copy live in pi while iterating:

```bash
pi -e /path/to/predexec/.pi/extension/index.ts   # or run `pi` inside the repo
```

(Inside the devcontainer the checkout is already mounted and the adapter loads from it, so your
edits are always what's measured.)

## Layout

```
dist/                              compiled ESM JavaScript (emitted by tsconfig.build.json)
.pi/extension/index.ts             pi adapter — JSON Schema + ctx wiring, delegates to core
.opencode/plugins/predexec.ts      opencode adapter — zod schema + context wiring, delegates to core
mcp/                               Claude Code / Codex / Antigravity adapter (stdio MCP), delegates to core
  server.ts                        the MCP server: one `predexec` tool (`--host` picks the policy reader)
  tool-ops.ts                      read/grep/find/ls over node:fs (rg/fd accelerate when present)
  policy-claude.ts                 reads your Claude Code permission rules → policyStop
  policy-codex.ts                  reads Codex's config.toml + execpolicy rules → policyStop, fail-closed
  policy-antigravity.ts            reads agy's settings.json grants (Deny > Ask > Allow) → policyStop, fail-closed
core/                              PURE TS, zero harness imports (promotable to a standalone package)
  types.ts conditions.ts runner.ts engine.ts destructive.ts coerce.ts index.ts
steering.ts                        shared steering text/marker + renderSkill (harness-facing; not in core/)
stats.ts                           request-accounting recorder (append-only JSONL; harness-facing)
policy.ts                          opencode permission reader/checker (harness-facing)
adapter-runtime.ts                 shared adapter execution & stats runtime
bin/predexec.mjs                   CLI: doctor + stats + install-skill (node builtins only)
bin/predexec-mcp.mjs               MCP entrypoint (`--host codex|antigravity` selects the host; `--root` for antigravity)
.pi/skills/predexec/SKILL.md       pi routing skill (loaded via pi.skills)       } generated from steering.ts
skills/<harness>/predexec/SKILL.md claude / codex / opencode routing skills     } by `pnpm skills`;
antigravity-plugin/skills/predexec/SKILL.md  Antigravity routing skill          } never edit by hand
.claude-plugin/plugin.json         Claude Code plugin manifest (MCP server + skills path)
.claude-plugin/marketplace.json    self-hosting marketplace listing (source: "./") for `/plugin install`
.codex-plugin/plugin.json          Codex plugin manifest (mcpServers/skills point at companion files)
.codex-plugin/mcp.json             Codex plugin's MCP server config (env_vars forwards CODEX_HOME)
.agents/plugins/marketplace.json   self-hosting marketplace listing (path: "./") for `codex plugin add`
configs/opencode/AGENTS.md         drop-in routing block for opencode projects
configs/codex/AGENTS.md            paste-ready routing block for Codex projects (fallback, no plugin)
```
