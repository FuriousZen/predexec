# predexec

**Predictive execution** for LLM coding agents. predexec collapses an adaptive, multi-level
tool sequence into a **single model round-trip**: the model pre-compiles its branch decisions
into a tree of deterministic predicates, and an engine walks the tree with **no model call
between levels**. On a request-limited free provider this trades abundant tokens for scarce
provider requests.

This package is a [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
extension registering one tool, `predexec`. See [CLAUDE.md](../CLAUDE.md) for the full design
and current status.

> **Status: read-only MVP.** The pure-TS core and the pi adapter are done and unit-tested.
> predexec speculates **read-only only** — any write/install/delete hard-stops before running.

## How it works

The model fills in a **plan tree**: each node is a shell command batch; each edge is a
machine-evaluable **condition** on that node's output. After running a node, the engine
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

## Try it out in a workspace

**Prerequisites:** Node 22+ and the pi coding agent on your PATH (`npm i -g
@earendil-works/pi-coding-agent`), with a provider configured in `~/.pi` (any provider works;
predexec's payoff is largest on a request-limited free tier such as NVIDIA NIM or OpenRouter
free). This repo also ships a `.devcontainer/` (Node 22 + pi + opencode, wired to NVIDIA NIM)
if you'd rather develop in a container.

```bash
# 1. clone and install dev deps (pnpm — the project's package manager)
git clone <this-repo-url> predexec && cd predexec
corepack enable            # makes pnpm available (ships with Node)
pnpm install

# 2. launch pi in any project directory with predexec loaded live (no install step)
cd /path/to/some/project
pi -e /path/to/predexec/index.ts
```

`-e` loads the extension's `.ts` directly via jiti — no build. Once pi starts, the `predexec`
tool is registered and the model will route multi-step work through it on its own.

**A prompt to see it work** (read-only, structurally predictable — predexec's sweet spot):

```
Detect this project's package manager and run its test script.
```

The model can plan one tree: probe for a lockfile / read `package.json` scripts, branch on
what it finds (`fileExists pnpm-lock.yaml`, `jsonPath scripts.test exists`), and run the right
test command — resolving several branch points in a single round-trip instead of one model
call per step. Inspect the tool result's `details` (`depthReached`, `pathTaken`,
`stoppedReason`, `edgesEvaluated`/`edgesMatched`) to see the path the engine walked.

## Develop

```bash
pnpm install
pnpm test          # vitest unit tests (core)
pnpm run typecheck # tsc --noEmit
```

## Install into pi (persistent)

Copy this directory into pi's global extensions dir and install runtime deps:

```bash
cp -r predexec ~/.pi/agent/extensions/predexec
cd ~/.pi/agent/extensions/predexec && pnpm install --prod
```

pi auto-discovers `~/.pi/agent/extensions/*/index.ts` on start.

## Layout

```
index.ts     pi adapter — builds the typebox schema, wires ctx.cwd + signal, delegates to core
core/        PURE TS, zero harness imports (promotable to a standalone package)
  types.ts conditions.ts runner.ts engine.ts schema.ts index.ts
core/*.test.ts   vitest unit tests
```
