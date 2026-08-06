# PLAN — predexec as a Claude Code extension

Status: **proposed**. Target: predexec 0.2.0.

Every claim below is grounded in a source that was fetched and read, or in a command
that was run, during planning. Citations are inline. Anything unverified is marked
**UNVERIFIED** and must be settled before the code that depends on it is written.

---

## 1. Route: MCP stdio server (the only option)

Claude Code exposes no in-process tool-registration API to third-party packages. Plugins
ship *components* (skills, agents, hooks, MCP servers, LSP servers, monitors) — a plugin
cannot register a native tool the way the pi extension or the opencode plugin does.

> "A **plugin** is a self-contained directory of components that extends Claude Code with
> custom functionality. Plugin components include skills, agents, hooks, MCP servers, LSP
> servers, and monitors."
> — https://code.claude.com/docs/en/plugins-reference.md

So the predexec tool reaches Claude Code as an **MCP tool** over a stdio server. This is a
harder boundary than pi or opencode: those adapters run *inside* the host and borrow the
host's own tool factories. An MCP server is a separate process with none of that.

Consequences that shape the rest of this plan:

| pi / opencode | Claude Code (MCP) |
| :-- | :-- |
| In-process; imports host tool factories | Separate process; no host APIs at all |
| Host enforces its own Bash permission policy | **Host permission rules do not reach us** (§3) |
| `executeToolOp` delegates to native read/grep/find/ls | We must implement them ourselves (§4) |
| Steering via extension/plugin hooks | Steering via skill + tool description (§5) |

---

## 2. Layout

`core/` stays pure and untouched. The adapter is a sibling that imports only
`core/index.ts`, exactly like the existing two.

```
mcp/
  server.ts          stdio MCP server: registers the `predexec` tool, calls runPlanTree
  tool-ops.ts        read/grep/find/ls implemented over node:fs (+ rg/fd when present)
  policy-claude.ts   Claude Code settings reader → deny/ask rules → policyStop  (§3)
bin/
  predexec-mcp.mjs   thin launcher (new `bin` entry) so `npx -y predexec-mcp` just works
.claude-plugin/
  plugin.json        optional one-command-install wrapper
.mcp.json            server declaration used by the plugin wrapper
skills/predexec-claude/SKILL.md   Claude Code steering skill
```

**Invariant preserved:** nothing in `mcp/` may be imported by `core/`, and `mcp/` imports
from core only via `core/index.ts`.

### Install paths (two, both documented)

1. **Direct MCP** — the primary route, no plugin needed:
   `claude mcp add predexec -- npx -y predexec-mcp`
2. **Plugin wrapper** — for one-command install plus the bundled skill. `.mcp.json`
   invokes the same `npx` command rather than a bundled script, which deliberately
   sidesteps the documented "plugin needs its own `node_modules`" problem, where a plugin
   must persist dependencies into `${CLAUDE_PLUGIN_DATA}` and run `npm install` from a
   hook (plugins-reference.md line 735). Because our server is an npm package already, npx
   resolves it and its dependencies with no such dance.

Manifest requirements: `name` is the only required field; `mcpServers` may be a path
string such as `"./.mcp.json"`; `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and
`${CLAUDE_PROJECT_DIR}` are the available path variables (plugins-reference.md lines 461,
533, 680).

---

## 3. Permissions — the centerpiece of this plan

### The problem

predexec's standing invariant is: *predexec cannot prompt mid-walk, so it never bypasses a
would-be prompt.* On opencode, `policy.ts` enforces this by reading `permission.bash` deny
**and** ask rules and turning either into a `policyStop`.

On Claude Code that enforcement does not come for free. Verified verbatim:

> "Read and Edit deny rules apply to Claude's built-in file tools and to file commands
> Claude Code recognizes in Bash, such as `cat`, `head`, `tail`, and `sed`. **They don't
> apply to arbitrary subprocesses that read or write files indirectly, like a Python or
> Node script that opens files itself.** For OS-level enforcement that blocks all processes
> from accessing a path, [enable the sandbox]."
> — https://code.claude.com/docs/en/permissions.md, line 272

An MCP server is exactly such a subprocess. A shell command predexec runs internally is
**not** filtered by the user's `Bash(...)` allow/ask/deny rules. MCP tools are permissioned
at the granularity of the tool itself — `mcp__predexec__predexec` — not at the granularity
of what that tool does inside (permissions.md lines 371–373).

### The decision

**Rejected:** the framing that this bypass is a convenience — that because Bash rules don't
apply, predexec is free of them. That would make predexec a permission-laundering path on
Claude Code: a user who wrote `deny: ["Bash(curl *)"]` would find predexec running `curl`
anyway, on the harness where they are most likely to run it. A bypass is not a feature.

**Adopted:** `mcp/policy-claude.ts` mirrors `policy.ts`. predexec reads Claude Code's own
settings, evaluates the user's Bash rules itself, and hard-stops the walk via the engine's
existing `policyStop` before running any command a deny **or** ask rule would have caught.
predexec is strictly more conservative than the host, never less.

### Rules to encode (all verified in permissions.md)

- **Deny-first precedence** (line 39): a matching deny beats any allow, and a matching ask
  prompts even when a narrower allow also matches. So: *any* deny-or-ask match →
  `policyStop`, regardless of allow rules. Allow rules never widen what predexec will run.
- **Glob semantics**: the space before `*` is significant — `Bash(ls *)` matches `ls -la`
  but not `lsof`, while `Bash(ls*)` matches both. `Bash(ls:*)` is equivalent to
  `Bash(ls *)`, and the `:*` form is only recognized at the end of a pattern.
- **Ignore parameter-form command rules**: Claude Code itself ignores `Bash(command:rm *)`
  and emits a startup warning, because a compound command would bypass it. Our parser must
  ignore it too rather than honoring a rule the host does not.
- **Settings sources, in precedence order** (lines 516–524): managed settings → CLI →
  `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`.
- **`settings.local.json` resolves from the git repository root**, not the cwd, since
  v2.1.211 (line 450). Read it from the repo root.

Because deny/ask are restrictive-only, they apply regardless of workspace trust (line 534) —
so predexec must honor them even in an untrusted workspace.

### Defense in depth

The three existing mutation layers (declared `mutates:true`, the `core/destructive.ts`
heuristic, host policy) all remain. `policy-claude.ts` replaces only the third layer's
opencode-specific source. Sandboxing is the OS-level backstop and is the user's to enable;
the docs name it as the only thing that genuinely constrains subprocesses (line 272), and
the README should say so for Claude Code users.

---

## 4. Tool ops — an honest parity gap

pi wires `read`/`grep`/`find`/`ls` to the host's own tool factories, giving exact parity
with the native tools. An MCP server has no such factories. Decision:

**Implement the four ops in `mcp/tool-ops.ts` over `node:fs`**, shelling out to `rg`/`fd`
only when they are on PATH and degrading to a pure-Node walk when they are not. Do **not**
implement reads by shelling out generally — that would push read traffic back through the
shell path that §3 exists to gate.

This is a real behavioral difference from the pi adapter and must be **documented as a gap,
not described as parity**. Specifically: line-numbering, truncation and binary-file
handling will match predexec's own `OUTPUT_CAP` conventions rather than Claude Code's
native Read tool byte-for-byte.

Ops must respect the same read-only contract: `read`/`grep`/`find`/`ls` are safe;
`edit`/`write`/unknown hard-stop, unchanged from `core/`.

---

## 5. Steering

Mirror the existing split:

- **Always-on**: the MCP tool's `description` — the one signal that cannot be turned off.
  Sourced from `steering.ts` so all three harnesses stay in sync.
- **Pull**: `skills/predexec-claude/SKILL.md`, shipped by the plugin wrapper. Frontmatter
  requires `description`; `name` defaults to the directory basename
  (https://code.claude.com/docs/en/skills.md).

Do **not** add a `PreToolUse` hook that rewrites Bash calls into predexec calls. It is
invasive, it fights the user's own permission rules, and hook decisions cannot bypass
permission rules anyway (permissions.md line 415).

---

## 6. MCP server implementation

Verified by installing the package and reading its type definitions, **not** from recall —
an earlier research pass got both of these wrong:

- `@modelcontextprotocol/sdk` current version: **1.30.0** (`npm view`).
- `McpServer` is declared in `dist/esm/server/mcp.d.ts` → import from
  `@modelcontextprotocol/sdk/server/mcp.js`. It is **not** in `server/index.js`; that path
  holds the low-level `Server`, which the SDK marks `@deprecated Use McpServer instead`.
- `registerTool(name, config, cb)` where `config.inputSchema` is a **raw Zod shape**
  (`ZodRawShapeCompat`) or a JSON Schema — *not* a `z.object(...)` wrapper.
- Transport: `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`.

Sketch:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "predexec", version: VERSION });

server.registerTool(
  "predexec",
  { description: TOOL_DESCRIPTION, inputSchema: { plan: z.unknown() } }, // raw shape
  async ({ plan }) => { /* coercePlan → runPlanTree → transcript */ },
);

await server.connect(new StdioServerTransport());
```

### Decision D3 — dependency weight (flagged for the owner)

`@modelcontextprotocol/sdk` pulls express, hono, cors, jose, ajv, eventsource and more,
because it bundles HTTP/SSE transports and OAuth that a stdio server never touches. predexec
currently has exactly one runtime dependency (`zod`).

Options: (a) accept the SDK in `dependencies`; (b) hand-roll the JSON-RPC-over-stdio loop —
initialize / `tools/list` / `tools/call` is a small surface and adds zero dependencies;
(c) split the MCP server into its own npm package so `predexec` stays lean.

**Recommendation: (a).** Protocol-version negotiation is a moving target and correctness
against a real client beats dependency count. Revisit if install weight becomes a real
complaint. This is the one decision in this plan an owner might reasonably overrule.

---

## 7. Packaging

- Add `mcp`, `.claude-plugin`, `.mcp.json` to the `files` allowlist. **The allowlist is
  opt-in — a directory that is not listed ships as an empty install.**
- Add the `predexec-mcp` bin entry. Do **not** repoint `main` (opencode's entry).
- Add `@modelcontextprotocol/sdk` to `dependencies` (per D3).
- Bump to **0.2.0** — new adapter, not a patch.
- **Gate before publish:** `npm pack --dry-run` and confirm every runtime import of the new
  adapter appears in the packed file list. This is the check that catches an allowlist miss,
  and an allowlist miss ships silently broken.

---

## 8. doctor

Add `checkClaudeCode()` following the three-state convention now used by the pi and opencode
checks (`ok` / `fail` / `info` / `skip`; only `fail` sets exit 1):

- Claude Code absent from PATH and no `~/.claude` → `skip`.
- Present but predexec not in any MCP config → `info`.
- Configured but the server fails to start or does not advertise the tool → `fail`.

Config locations, settled empirically by running `claude mcp add` in a scratch repo and
inspecting the resulting files (CLI 2.1.223):

| Scope | File | Key |
| :-- | :-- | :-- |
| project | `<project>/.mcp.json` | `mcpServers` |
| user | `~/.claude.json` | `mcpServers` |
| local | `~/.claude.json` | `projects["<abs path>"].mcpServers` |
| plugins | `~/.claude/settings.json` | `enabledPlugins` |

Server entry shape is `{ type: "stdio", command, args: [], env: {} }`. Note that a
project-scope server starts as **"Pending approval"** until the user approves it in an
interactive session — so `checkClaudeCode` must treat "declared but unapproved" as `info`
with an actionable hint, not as `fail`. The per-project `enabledMcpjsonServers` /
`disabledMcpjsonServers` arrays in `~/.claude.json` record that approval decision.

---

## 9. Work order

1. `mcp/tool-ops.ts` + unit tests (pure, no MCP involved).
2. `mcp/policy-claude.ts` + unit tests — the glob semantics, deny-first precedence, the
   ignored `command:` form, and settings precedence each get a test.
3. `mcp/server.ts` + `bin/predexec-mcp.mjs`.
4. Plugin wrapper (`.claude-plugin/plugin.json`, `.mcp.json`, skill).
5. `files`/`bin`/deps/version in `package.json`.
6. `checkClaudeCode()` in doctor (after §8's UNVERIFIED item is settled).
7. README section; `CLAUDE.md` last, against the finished tree.

**Definition of done:** full vitest suite green, `tsc --noEmit` clean, `npm pack --dry-run`
contains every new runtime file, and a real `claude mcp add` session shows the tool and
executes a depth-0 plan end to end. A test suite alone does not close this out — the MCP
wiring is exactly the part unit tests cannot prove.
