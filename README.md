# predexec

**Predictive execution** for LLM coding agents. predexec collapses an adaptive, multi-level
tool sequence into a **single model round-trip**: the model pre-compiles its branch decisions
into a tree of deterministic predicates, and an engine walks the tree with **no model call
between levels**. On a request-limited free provider this trades abundant tokens for scarce
provider requests.

This package ships as both a [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
extension and an [opencode](https://opencode.ai) plugin, each registering one tool, `predexec`.
See [How it works](#how-it-works) below for the design and current status.

> **Status: read-only MVP.** The pure-TS core, pi adapter, and opencode adapter are done and
> unit-tested. predexec speculates **read-only only** — any write/install/delete hard-stops
> before running.

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
Restart opencode after editing. To update, bump the version (or use `"predexec@latest"`) and restart.

**Verify** (no model request needed):

```bash
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

> **Using the bundled devcontainer?** Nothing to do — `post-create` auto-installs predexec on
> every rebuild, and `.devcontainer/.env` injects `NVIDIA_API_KEY` + `OPENCODE_API_KEY` so the
> agent is authenticated on first boot (see `.env.example`).

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

## Develop / contribute

Clone and use pnpm (the project's package manager):

```bash
git clone https://github.com/FuriousZen/predexec && cd predexec
corepack enable     # makes pnpm available (ships with Node)
pnpm install
pnpm test           # vitest unit tests (core)
pnpm run typecheck  # tsc --noEmit
```

Load your working copy live in pi while iterating — no build, jiti loads the `.ts`:

```bash
pi -e /path/to/predexec/.pi/extension/index.ts   # or just run `pi` inside the repo (package.json pi.extensions)
```

(In the devcontainer the repo is already at `/workspaces/predexec/predexec` and the adapter
loads from this path, so your edits are always what's measured.)

## Layout

```
.pi/extension/index.ts             pi adapter — JSON Schema + ctx wiring, delegates to core
.opencode/plugins/predexec.ts      opencode adapter — zod schema + context wiring, delegates to core
core/                              PURE TS, zero harness imports (promotable to a standalone package)
  types.ts conditions.ts runner.ts engine.ts coerce.ts schema.ts index.ts
steering.ts                        shared steering text/marker (harness-facing; not in core/)
skills/predexec/SKILL.md           declarative pi routing skill (loaded via pi.skills)
configs/opencode/AGENTS.md         drop-in routing block for opencode projects
```
