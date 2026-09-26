# opencode v2 plugin API — contract for the predexec adapter

Source: `sst/opencode` tag `v2.0.16` (commit `3a103fe`), the version installed on the measuring
machine (`opencode --version` → `v2.0.16`). Paths below are relative to that tree's `packages/`.
The v2 plugin types ship as `@opencode/plugin` (2.0.18 on npm today), not `@opencode-ai/plugin`,
whose `latest` is still 1.18.32. predexec takes no dependency on either: the adapter declares the
slice it touches locally, as the v1 shim already did.

## 1. Module shape: why `{ id, server }` fails, and one export for both majors

- **v2 loader.** `core/src/plugin/module.ts:60-73` decodes the module with an Effect schema:
  `default` must be `Struct({ id: String, effect: fn })` or `Struct({ id: String, setup: fn })`.
  A decode failure raises `PluginModule.LoadError` with "Plugin must export a default definition
  with an id and an effect or setup function" (`:107-114`). That is the error Task 17 hit.
  `:116` wraps a `setup` plugin with `PluginPromise.fromPromise`, which is the Promise API.
- **Extra keys are stripped, not rejected.** Effect `4.0.0-rc.112`, the version pinned by the root
  `package.json:82` catalog, defaults `onExcessProperty` to `"ignore"` (`SchemaAST.ts:445`), and
  that default strips unknown keys. `server` next to `setup` therefore decodes cleanly. The host
  then calls `setup` off the stripped copy, so `setup` must not use `this`.
- **v1 loader.** opencode 1.18.32 `packages/opencode/src/plugin/shared.ts:272-304`
  (`readV1Plugin`, called from `plugin/index.ts:114-125`) checks only `server`/`tui` and never
  inspects other keys. An extra `setup` is invisible to it.
- **Result.** One default export, `{ id: "predexec", server, setup }`, satisfies both loaders.
  No second entry point or `exports` map is needed.
- **Entrypoint resolution.** v2 still admits a standalone local source from the legacy
  `.opencode/plugin{,s}/` auto-discovery (`module.ts:92-96`). That discovery takes every direct
  child `.ts`/`.js` file or directory of those two folders (`core/src/plugin/source-directory.ts:7-33`),
  which is why shared helpers live in `.opencode/lib/`, not `.opencode/plugins/`. An npm plugin
  resolves `<pkg>/server` first, then `<pkg>`, which is `main` (`plugin/src/host.ts:17-44`).
  `package.json` `main` is unchanged. v2 still accepts the v1 `plugin: [...]` config key and
  migrates it to `plugins` (`core/src/config/normalize.ts:185-190`).

## 2. Setup context (Promise API)

`plugin/src/promise/plugin.ts:26-61`: `setup(ctx)` receives `{ app, location, options, agent,
aisdk, command, event, integration, mcp, model, generate, permission, plugin, provider,
reference, rpc, session, shell, skill, storage, tool, vcs, websearch, worktree, experimental }`.
Registration is imperative. `ctx.<domain>.transform(cb)` edits stateful registries, and
`ctx.<domain>.hook(name, cb)` intercepts runtime events. Hook callbacks receive the host's live
event object, so mutations propagate (`promise/adapter.ts:503-504, 577-580`).
`ctx.location` is `{ directory, project: { id, directory, canonical } }`
(`schema/src/location.ts:19-27`). The adapter uses `location.directory` as the session root and
`location.project.directory` as the worktree.

## 3. Tool registration and argument schemas

- `ctx.tool.transform(editor => editor.add(info))` (`plugin/src/promise/tool.ts:26-36, 66-72`).
  `info` is `{ name, description, input, output?, options?, execute(input, ctx) → Promise<Result> }`
  (`promise/tool.ts:16-24`, `schema/src/tool.ts:92-102`). `Result` is `{ output?, content?, metadata? }`
  (`schema/src/tool.ts:86-90`). A tool with no `output` schema must not return an `output` key
  (`core/src/tool/runtime.ts:45-52`).
- **Input schema.** `Tool.ValueSchema` is an Effect codec, a Standard Schema, or a plain JSON Schema
  (`schema/src/tool.ts:44`). A JSON Schema is compiled to an Effect codec for validation
  (`core/src/tool/runtime.ts:70-85, 101-107`) and sent to the model as-is (`:154-158`).
- **Which zod the host pins.** zod `4.1.8` (root `package.json:97` catalog). A zod schema goes
  through its Standard-JSON-Schema hook when present. Otherwise it goes through
  `schema instanceof $ZodType` against the host's own zod (`runtime.ts:165-169`), and that
  `instanceof` fails across zod instances. **predexec's v2 tool therefore passes a plain JSON Schema**
  (`{type:"object", properties:{plan:{description}}, required:["plan"]}`), so no zod crosses the
  boundary. `coercePlan` stays the real validator.
- **CodeMode.** Plugin tools default into CodeMode. There they are callable only through the
  `execute` meta-tool, not listed natively (`core/src/tool/AGENTS.md:33`; split at
  `core/src/tool.ts:234-235`). Built-ins such as `read`, `grep`, `glob` and `shell` opt out with
  `options: { codemode: false }` (e.g. `core/src/tool/plugin/read.ts:42`). predexec does the same.
- **Tool context.** `{ sessionID, agent, messageID, id, signal, progress }`
  (`schema/src/tool.ts:14-20`, `promise/tool.ts:11-14`). It has no `directory`, `worktree` or `ask`.
- **Post-tool hook.** `ctx.tool.hook("execute.after", ev)` with
  `{ tool, input, status: "completed", result } | { …, status: "error", error }`
  (`promise/tool.ts:47-64`). The host reads `ev.result` back after the hook runs
  (`core/src/tool.ts:139-152`). v2's shell tool is named **`shell`** (`core/src/tool/plugin/shell.ts:22`,
  input `command` at `:47-48`), not `bash`.

## 4. System-prompt hook

`ctx.session.hook("context", ev)` gets `ev.system: SystemPart[]`, where a part is
`{ type: "text", text }` (`plugin/src/promise/session.ts:25-36`, `ai/src/schema/messages.ts:21-29`).
It fires only for the primary agent loop. Title, generate and compaction requests trigger their own
hooks (`core/src/session/model-request.ts:378-387`), so v1's sessionID guard for
`Agent.generate` has no counterpart to protect against. Skills are rendered into the system prompt
as `<available_skills>` (`core/src/skill/instructions.ts:32`). predexec's quorum check
(`systemHasRoutingInstructions`) keeps working against that block.

## 5. Config / skills registration

v2 has **no `config` hook**. The Context has no config domain, and `cfg.skills.paths` no longer
exists: `skills` is now a string array (`schema/src/config.ts:84-86`, read by
`core/src/config/plugin/skill.ts:77-103`). The replacement is
`ctx.skill.transform(editor => editor.add(Skill.Info))` (`plugin/src/promise/skill.ts:6-17`). Here
`Skill.Info = { id, name, description?, autoinvoke?, path, content }` (`schema/src/skill.ts:26-34`).
The built-in skills are registered exactly this way (`core/src/plugin/skill.ts:23-48`). The adapter
parses the packaged `skills/opencode/predexec/SKILL.md` the way v2's directory loader does:
`id` = parent dir, `name`/`description` from frontmatter, and `content` = the body
(`core/src/config/plugin/skill-file.ts:34-55`).

## 6. `ask` equivalent for permissions — **absent (degraded, fail-closed)**

- The v2 tool context carries no `ask` (§3). `ctx.permission` exposes only `list`/`get`/`reply` of
  pending requests plus an `evaluate` hook that rewrites the host's own evaluations
  (`plugin/src/promise/permission.ts:7-24`). A plugin cannot raise a permission prompt.
- The tool registry does no execution authorization. `options.permission` only filters which
  tools are visible (`core/src/tool/AGENTS.md:50-54`).
- **Degradation:** on v2 the static reader (`policy.ts`) is the whole check. A `deny` **or** `ask`
  match hard-stops before running. There is never a prompt.
- **v2 ruleset model (Task 17a fix round 1).** v2 does not mergeDeep config layers the way v1
  does. `readOpencodeRuleset(dir, env, { hostMajor: 2 })` builds the ruleset with v2's own model,
  as follows:
  - **Discovery and load order.** The global dir comes first (`OPENCODE_CONFIG_DIR` replaces it:
    util `global.ts:79`, cli `server-process.ts:108-115`), then `OPENCODE_CONFIG`, then the project
    `opencode.json`/`opencode.jsonc` files, then `.opencode/` dirs, then `OPENCODE_CONFIG_CONTENT`
    (core `config.ts:196-237`).
    - Project files and `.opencode/` dirs are found by walking from the session directory to the
      **filesystem root**, not the git root (`config/discovery.ts:23-84`; `fs.up` with no stop,
      util `fs-util.ts:162-178`).
    - Within those, farthest comes first, and `opencode.json` loads before `opencode.jsonc`.
    - Entries that resolve to a global root (the global config dir, `~/.claude`, `~/.agents`) or to
      a global file are dropped.
    - `OPENCODE_CONFIG_PROJECT_DISABLE` / `OPENCODE_DISABLE_PROJECT_CONFIG` skip the walk.
  - **Per-document rules.** Each document's rules are `[...tools, ...permission, ...permissions]`
    (`config/normalize.ts:179-183`).
    - Legacy keys go through `normalizeAction` (`bash`→`shell`, `write`/`patch`→`edit`,
      `task`→`subagent`; `v1/config/migrate.ts:117-122`).
    - The native `permissions: [{action, resource, effect}]` array (schema `permission.ts:55-66`)
      is taken verbatim. A native `bash` action is **not** renamed, so it never matches v2's `shell`
      requests; that matches the host.
  - **Agent ruleset.** It is built in this order (`config/plugin/agent.ts:83-124`):
    1. `Agent.Info.default` (schema `agent.ts:39-54`) plus the global external-directory allows
       (`agent.ts:59-64`).
    2. The built-in agent's pushes (`plugin/agent.ts:85-156`, `plugin/plan.ts:32-42`).
    3. **All** documents' top-level rules, concatenated.
    4. That agent's own rules from each document in order. For each document, legacy
       `agent`/`mode` entries are replaced wholesale by native `agents.<name>`
       (`normalize.ts:131-166, 731-743`).
    - `~`/`$HOME` are expanded only for the path actions (`agent.ts:141-162`).
    - A disabled agent, or an agent opencode does not know, evaluates as `[* * deny]`
      (`permission.ts:19,162`).
  - **Evaluation.** It is last-match-wins (`permission.ts:87-95`). predexec's shell requests are
    renamed `bash`→`shell` to match v2's shell tool (`tool/plugin/shell.ts:22,133-141`). Every path
    spelling predexec computes (worktree-relative, directory-relative, absolute) is checked for
    both deny and ask, because v2 file resources are directory-relative (`file-access.ts:100-111`).
  - **Fail-closed.** Any source that exists but cannot be parsed stops every operation. That
    includes malformed JSON, a native entry that is not `{action: string, resource: string,
    effect: allow|ask|deny}`, and a non-boolean `tools` value. v2 itself logs and *skips* such a
    document (`config.ts:104-133`); skipping could drop a deny.
- **Unmodeled runtime and remote state.** These are not modeled:
  - `session.permissions`, which v2 merges into each evaluation after the agent's rules
    (`core/src/permission.ts:162`). It is per-session runtime state that a plugin cannot read.
  - Well-known (Console/integration) configs, which need network and credentials.
  - Console managed-policy statements, applied through a `permission.evaluate` hook
    (`core/src/config/plugin/policy.ts:44-51`).
  - `{env:…}`/`{file:…}` variable substitution inside config files.
  - The ordering of built-in agent transforms relative to the config agent transform is taken
    from plugin registration order. It was not measured.
  - All of these can make the host stricter than predexec's view, but only through state predexec
    cannot see. The live run in §8 exercised the modeled path.

## 7. File / find / grep client API — **absent**

The Promise context (§2) has no file, find or filesystem client. v1's `client.file.*` /
`client.find.*` have no v2 plugin equivalent. On v2, native tool ops (`read`/`grep`/`find`/`ls`)
run through `mcp/tool-ops.ts`, the same node:fs executor Claude Code and Codex use. It is rooted
at `location.directory`, keeps realpath containment, and marks truncation explicitly. Its exit
conventions are grep/find `1` = searched, found nothing; `2` = never ran; read/ls `1` = failure.
`exit == 0` branches identically on every harness. On v1-opencode, by contrast, every op that
never ran exits 2 (read/ls included). The v2 `plan` argument description states this, so plans
gate on `exit == 0` rather than on a specific failure code. The v1 SDK path's 10-match grep cap and
200-result find ceiling do not apply on v2.

## 8. Live verification — opencode v2.0.16 on the measuring machine

Isolation: a scratch project plus scratch `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
`XDG_CACHE_HOME` and `XDG_STATE_HOME`, with the `OPENCODE_*` config env vars unset. Every
invocation was `--standalone`. Without that flag the CLI tries to start a managed background
service; it collided with the user's own service port and exited without touching it.
`~/.config/opencode` and `~/.local/share/opencode` were never read or written. `opencode run`
blocks reading stdin when stdin is not a TTY, so every run redirected `< /dev/null`.

No model auth was needed. A ~60-line local OpenAI-compatible server
(`provider.fake.npm = "@ai-sdk/openai-compatible"`, which v2 bundles natively) recorded every
request. On the first request that offered `predexec`, it answered with one `predexec` tool call
carrying a fixed plan, then answered `done` once a tool result came back. So each check below
reads the requests opencode actually sent. Nothing is simulated.

Build under test: the `npm pack` tarball, installed into the scratch project with `npm install`
(real production deps). It was loaded through a one-line `.opencode/plugins/predexec.js`
re-export of `node_modules/predexec/dist/.opencode/plugins/predexec.js`. A second run used an
rsync of the source checkout (`.opencode/plugins/predexec.ts`, loaded as TypeScript).

| Check | Result |
|---|---|
| Plugin loads with no LoadError | **PASS**: `loading plugin …/predexec.js` then no `LoadError` (packed build), and the same for the source `.ts` |
| `predexec` tool listed | **PASS**: the request's `tools` = `edit, glob, grep, predexec, question, read, shell, skill, subagent, webfetch, websearch, write, execute`. It is native (not behind CodeMode `execute`), with the JSON-Schema `plan` parameter and description |
| One read-only plan runs | **PASS**: `cat marker.txt` + `{tool:"ls"}`, edge `exit == 0` → `{tool:"grep",pattern:"hello"}`. The tool result had `## node a (exit 0)` … `## node b (exit 0)` `marker.txt:1:hello`. The source checkout ran `cat` + `{tool:"read"}` → exit 0 |
| Skill discoverable | **PASS**: the system prompt's `<available_skills>` lists `<id>predexec</id><name>predexec</name>` with the packaged description |
| Steering fallback | **PASS**: with the skill visible, the routing text appears once (the skill description) and the hook stays silent. With `permission.skill = "deny"`, the skill disappears from the prompt and the hook injects `STEERING_LINE` (still exactly one occurrence) |
| Static deny | **PASS**: `permission.bash["cat *"] = "deny"` → `POLICY HARD-STOP (not run)` … `'cat *'` |
| `ask` with no host prompt | **PASS**: `"ask"` → the same hard-stop, and no prompt |
| v2-native `permissions` (fix round 1, re-packed build) | **PASS**: `[{shell, cat *, deny}]` → hard-stop `'shell:cat *'`. Adding a later `{shell, cat marker.txt, allow}` → runs (last match wins) |
| Per-document layering (review repro) | **PASS**: global `bash {*:deny, cat *:allow}` + project `bash {*:deny}` → hard-stop `'shell:*'` (v1 mergeDeep would have allowed it) |
| Config above the git root | **PASS**: an `opencode.json` in the scratch project's parent (outside its git repo) with `bash {cat *: deny}` → hard-stop |

**UNVERIFIED:** npm-name resolution (`plugins: ["predexec"]` → `Host.resolve` → `main`). It needs
the registry and would install the published version, not this build. It rests on the source read
in §1: `predexec/server` does not exist, so resolution falls back to `predexec` → `main`, which is
the same file the live run loaded. A live opencode **1.x** run was not repeated: no 1.x binary is
installed. The v1 path is covered by the existing `__tests__/opencode.test.ts` suites, which still
pass against both the source and the compiled build.
