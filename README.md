# predexec

**Predictive execution** for LLM coding agents. predexec collapses an adaptive, multi-level
tool sequence into a **single model round-trip**: the model pre-compiles its branch decisions
into a tree of deterministic predicates, and an engine walks the tree with **no model call
between levels**. On a request-limited free provider this trades abundant tokens for scarce
provider requests.

This package ships three adapters, each registering one tool, `predexec`:
a [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension,
an [opencode](https://opencode.ai) plugin, and a
[Claude Code](https://code.claude.com/docs/en/overview) MCP server.
See [How it works](#how-it-works) below for the design and current status.

> **Status: read-only.** The pure-TS core and all three adapters are done and unit-tested.
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

| | **pi** | **opencode** | **Claude Code** |
| :-- | :-- | :-- | :-- |
| Integration | in-process extension | in-process plugin | out-of-process **stdio MCP** |
| Tool registration | native (`pi.extensions`) | native (`plugin` array) | MCP tool — the only route CC offers a third party |
| `read`/`grep`/`find`/`ls` | the host's **own tool factories** — exact parity | host SDK, with real caps | **own implementation** over `node:fs` (`rg`/`fd` accelerate) |
| Steering | skill auto-loaded via `pi.skills` | guarded system-prompt push, or `AGENTS.md` | skill via plugin wrapper + tool description |
| Streaming progress | yes (`onUpdate`) | no | no |
| Host permission rules | n/a — pi has no per-command rules (project-trust only) | reads `permission.bash`, last-match-wins | **self-enforced** from `settings.json` (host rules don't reach a subprocess) |
| `.ts` loading | jiti | Bun | jiti |
| **Fit** | **9 / 10** | **7 / 10** | **6 / 10** |

**pi — 9.** Everything the design wants exists natively: predexec borrows pi's real tool
implementations, so a plan's `read` is *the* `read`; the routing skill auto-registers; progress
streams. Nothing is approximated. The missing point is not predexec's doing — pi has no
per-command permission model to honor, so the mutation hard-stop is the only guard, and pi ships
no sandbox.

**opencode — 7.** Native tool registration and a real permission model predexec enforces. Points
lost to measured SDK limits that predexec can only report, not fix: grep is **hard-capped at 10
matches** server-side, `file.read` has no offset/limit and returns trimmed content, and `find` is
fuzzy where pi's is glob-based. An npm-installed plugin also can't auto-register a skill, so
steering falls back to a guarded system-prompt push.

**Claude Code — 6.** It works, and MCP is the only door — but out-of-process costs are real.
There are no host tool factories, so `mcp/tool-ops.ts` is a second implementation of
read/grep/find/ls with its own behavior (`.gitignore` handling, regex dialect, output format).
Your `Bash(...)` rules don't reach the subprocess, so predexec re-reads and enforces them
itself. No streaming progress. What it does keep is the thing that matters: the same `core/`
engine, the same plan tree, the same hard-stops.

## Install

### pi coding agent

```bash
pi install npm:predexec
```

That's the whole install. pi fetches the package from npm, runs `npm install --omit=dev`
(one runtime dependency, `zod`), and registers the `predexec` tool from the package's
`pi.extensions` manifest (plus a terse routing skill from `pi.skills`,
`skills/predexec/SKILL.md`) — no build step (it's loaded as `.ts` via jiti). Once pi
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

That's the whole install — opencode resolves the plugin from npm, loads `.opencode/plugins/predexec.ts`
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

The plugin injects a one-line routing rule into the system prompt as a **guarded fallback**.
To steer declaratively instead, copy the routing block into your project's `AGENTS.md`:

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

The one-liner, no plugin required:

```bash
claude mcp add predexec -- npx -y --package=predexec predexec-mcp
```

Use `--scope project` to share it with a repo (writes `.mcp.json`, which each collaborator
approves once), or `--scope user` for every project on the machine.

**Verify:**

```bash
claude mcp list          # predexec → ✔ Connected
npx -y predexec doctor   # shows the registered scope, and flags "awaiting approval"
```

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
- predexec's own `read`/`grep` tool ops don't consult `Read(...)`/`Edit(...)` deny rules yet.
  For OS-level enforcement that binds every process, enable
  [sandboxing](https://code.claude.com/docs/en/sandboxing).

#### Plugin form (optional)

The repo also carries a plugin wrapper (`.claude-plugin/plugin.json`) that bundles the MCP
server with a routing skill. The server config is **inlined** in the manifest rather than kept in
a root `.mcp.json` — a root `.mcp.json` is a live project-scope registration, so it would prompt
anyone who merely opened this repo in Claude Code. It shells out to the same `npx` command rather
than vendoring `node_modules`, so there is no dependency-bundling step.

### A prompt to see it work

A read-only, structurally predictable task — predexec's sweet spot:

```
Detect this project's package manager and run its test script.
```

The model can plan one tree: probe for a lockfile / read `package.json` scripts, branch on
what it finds (`fileExists pnpm-lock.yaml`, `jsonPath scripts.test exists`), and run the right
test command — resolving several branch points in a single round-trip instead of one model
call per step. Inspect the tool result's `details` (`depthReached`, `pathTaken`,
`stoppedReason`, `edgesEvaluated`/`edgesMatched`) to see the path the engine walked.

## Doctor & stats

predexec ships a CLI (`bin/predexec.mjs`, node builtins only) for install diagnostics and
request accounting:

```bash
npx -y predexec doctor              # node version + pi / opencode / Claude Code wiring
npx -y predexec doctor --live       # + spawns opencode and probes tool registration
npx -y predexec stats               # aggregate recorded runs: ops collapsed, requests saved, edge hit-rate
```

`doctor` reports four states and **exits non-zero only for `[!]`** — a machine that simply
doesn't use a given harness is healthy, not broken:

| | meaning |
| :-- | :-- |
| `[x]` | wired and healthy |
| `[!]` | predexec IS wired here but is broken — the only state that fails |
| `[ ]` | harness installed, predexec not wired (actionable) |
| `[-]` | harness not installed |

Stats are append-only JSONL in `$PREDEXEC_STATE_DIR` (or `$XDG_STATE_HOME/predexec`, or
`~/.local/state/predexec`). Each adapter calls `recordRun` after every `runPlanTree` — fire-and-forget,
errors swallowed (a stats failure must never break a tool call).

## Develop / contribute

Clone and use pnpm (the project's package manager):

```bash
git clone https://github.com/FuriousZen/predexec && cd predexec
corepack enable     # makes pnpm available (ships with Node)
pnpm install
pnpm test           # vitest — 462 tests
pnpm run typecheck  # tsc --noEmit
```

Load your working copy live in pi while iterating — no build, jiti loads the `.ts`:

```bash
pi -e /path/to/predexec/.pi/extension/index.ts   # or just run `pi` inside the repo (package.json pi.extensions)
```

(Inside the devcontainer the checkout is already mounted and the adapter loads from it, so your
edits are always what's measured.)

## Layout

```
.pi/extension/index.ts             pi adapter — JSON Schema + ctx wiring, delegates to core
.opencode/plugins/predexec.ts      opencode adapter — zod schema + context wiring, delegates to core
mcp/                               Claude Code adapter (stdio MCP), delegates to core
  server.ts                        the MCP server: one `predexec` tool
  tool-ops.ts                      read/grep/find/ls over node:fs (rg/fd accelerate when present)
  policy-claude.ts                 reads your Claude Code permission rules → policyStop
core/                              PURE TS, zero harness imports (promotable to a standalone package)
  types.ts conditions.ts runner.ts engine.ts destructive.ts coerce.ts schema.ts index.ts
steering.ts                        shared steering text/marker (harness-facing; not in core/)
stats.ts                           request-accounting recorder (append-only JSONL; harness-facing)
policy.ts                          opencode permission reader/checker (harness-facing)
bin/predexec.mjs                   CLI: doctor + stats (node builtins only)
bin/predexec-mcp.mjs               Claude Code MCP entrypoint (`npx --package=predexec predexec-mcp`)
skills/predexec/SKILL.md           declarative pi routing skill (loaded via pi.skills)
skills/predexec-claude/SKILL.md    Claude Code routing skill (shipped with the plugin wrapper)
.claude-plugin/plugin.json         optional Claude Code plugin wrapper
configs/opencode/AGENTS.md         drop-in routing block for opencode projects
```
