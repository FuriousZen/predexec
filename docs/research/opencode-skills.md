# opencode skill registration — measurement notes (Task 17)

Backs the `config`-hook skill registration added in `.opencode/plugins/predexec.ts`
(appends the packaged `skills/opencode` directory to `cfg.skills.paths`). Two separate
checks were done: a source-level audit against the exact opencode version this adapter
targets, and a live run attempt against the opencode binary actually installed on the
measuring machine.

## 1. Source audit — opencode v1.18.32 (exact version match, `git describe` = `v1.18.32`)

Confirmed against a clone of `sst/opencode` at tag `v1.18.32` (matches the version this
adapter's other comments already cite):

- `packages/opencode/src/project/bootstrap.ts:36-38` — `plugin.init()` runs immediately
  after `config.get()` and before every other service (`lsp`, `shareNext`, `format`,
  `vcs`, `snapshot`, `project`), with the comment "Plugin can mutate config so it has to
  be initialized before anything else."
- `packages/opencode/src/plugin/index.ts:152` — `const cfg = yield* config.get()` is
  captured ONCE per instance and reused for every hook: `packages/opencode/src/plugin/
  index.ts:245-253` calls `hook.config?.(cfg)` for every loaded plugin hook, passing the
  SAME object reference, not a copy.
- `packages/opencode/src/config/config.ts:620-622` — `Config.Service.get()` returns
  `InstanceState.use(state, (s) => s.config)`: a single memoized object per instance,
  computed once by `loadInstanceState`. This is what makes the `plugin/index.ts:152`
  reference and every later `config.get()` call (including the one skill discovery makes)
  resolve to the identical object — mutating it in the `config` hook is visible everywhere
  else that reads `config.get()` afterwards.
- `packages/opencode/src/skill/index.ts:210-220` (`discoverSkills`) — reads
  `(yield* config.get()).skills?.paths`, and for each entry does
  `path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)` then
  `scan(state, dir, SKILL_PATTERN)` where `SKILL_PATTERN = "**/SKILL.md"` (line 25) — no
  `.opencode`/`.claude` scoping applies to `skills.paths` entries, so an arbitrary absolute
  directory (what the plugin now appends) is scanned correctly, one level deep or nested,
  same as any other `**/SKILL.md` glob.
- `packages/opencode/src/skill/index.ts:250-286` (`Service` layer) — `discoverSkills` is
  wrapped in `InstanceState.make(...)`, i.e. lazy: it only materializes on first
  `InstanceState.get(discovered)`, which happens later still (via `Skill.available` /
  `Skill.all`, called from system-prompt building). Combined with the point above, the
  `config` hook's mutation (synchronous, during `plugin.init()` at bootstrap) always
  happens-before the lazy skill scan reads the same object, with no explicit ordering glue
  needed.
- `packages/opencode/src/session/system.ts:107-118` (`SystemPrompt.skills`) — returns
  early (no skills section at all) when `Permission.disabled(["skill"], agent.permission)`
  includes `"skill"`; otherwise renders `Skill.fmt(list, { verbose: true })`.
- `packages/opencode/src/skill/index.ts:321-338` (`fmt`, verbose branch) — emits
  `<available_skills>` with, per skill, only `<name>`, `<description>`, and
  `<location>` (escaped). Skill **content** (the SKILL.md body) is never in the always-
  resident system prompt — confirms only name+description are unconditionally present,
  matching the frontmatter requirement in `packages/web/src/content/docs/skills.mdx`.

**Conclusion from the audit:** the `config`-hook approach is correct for opencode
v1.18.32 — the hook fires before any consumer reads the mutated field, mutating the field
is the host's own documented plugin contract, and the packaged skill's frontmatter
`description` (via `steering.ts`'s `SKILL_DESCRIPTION`, which is built FROM
`STEERING_LINE`) already satisfies the `systemHasRoutingInstructions` 2-of-3 marker
quorum on its own — a project doesn't need a hand-written `AGENTS.md` block for the
system-prompt-injection fallback to correctly stay silent once the skill is visible.

## 2. Live run — opencode v2.0.16 (installed on the measuring machine)

`opencode --version` on this machine reports `v2.0.16` — a major version newer than the
`v1.18.32` source audited above. Per instructions, this was run only inside an isolated
scratch project, never against the user's real `~/.config/opencode`:

- Scratch project: a full rsync of this repo (minus `.git`, `node_modules`, `__tests__`)
  into a scratchpad directory, with `node_modules` symlinked back to the real repo's (for
  `zod` resolution) — i.e. the SAME `.opencode/plugins/predexec.ts` this task edited,
  loaded via opencode's documented dev-checkout auto-discovery path (no `opencode.json`
  `"plugin"` entry needed).
- Isolated environment: `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`,
  `XDG_STATE_HOME` all pointed at a scratch home directory, so nothing was read from or
  written to the real `~/.config/opencode`. Command:
  `opencode run --standalone --print-logs --log-level debug "say hi"`, run from inside the
  scratch project directory, backgrounded, killed after 25s.
- `git status` in the real repo was checked before and after: only this task's own
  intentional edits are present — the run left no stray files anywhere in the real
  checkout.

**Result: the plugin failed to load**, before reaching config-hook or skill-discovery
logic at all:

```
level=WARN message="failed to load plugin" \
  target=.../.opencode/plugins/predexec.ts \
  cause="Cause([Fail(PluginModule.LoadError: Plugin must export a default definition \
  with an id and an effect or setup function. (cause: SchemaError(Missing key \
  ["default"]["effect"] Missing key ["default"]["setup"])))])"
```

opencode v2.0.16 validates plugin modules against a different shape —
`{ id, effect }` or `{ id, setup }` — than the `{ id, server() }` shape
(`readV1Plugin`) this adapter (and its file-header comment, and `bootstrap.ts:114-125`
in the v1.18.32 source: `applyPlugin`/`getLegacyPlugins`) targets. This is a **plugin
module contract change between major versions**, not a config-hook-ordering problem —
the load fails at the schema-validation step, before opencode would ever call `config()`,
`experimental.chat.system.transform`, or discover skills. There was no `opencode debug
skill` subcommand in this v2.0.16 build either (`opencode debug --help` lists only
`agents`, `config`, `paths`); the closest available signal was this plugin-load log line.

**Status: UNVERIFIED for opencode v2.0.16.** The `config`-hook skill-registration
mechanism could not be exercised live on this machine because the installed opencode CLI
already can't load ANY plugin in this adapter's current export shape — a pre-existing,
broader compatibility gap (the whole adapter targets ≥1.17.x `readV1Plugin` semantics),
not something introduced or fixable by this task. No attempt was made to install a
different opencode version to work around it (that would mean changing the user's global
opencode installation, which wasn't asked for).

## Net effect on Task 17's fallback decision

Per the task's own instruction, since live verification on this host was blocked (by a
version-mismatch load failure, functionally the same outcome as a hook-ordering
failure would have been — no skill gets registered either way), the manual fallback
stays documented and doctor's existing behavior stays as-is:

- `configs/opencode/AGENTS.md` is now framed as a manual fallback (see its own header).
- `install-skill opencode` remains available and documented in `README.md` as the manual
  path for a host where the automatic `config`-hook registration doesn't apply.
- `doctor`'s opencode skill check (`checkOpencodeSkill` in `bin/predexec.mjs`) only
  inspects on-disk config and skill directories; it has no way to observe the config
  hook's in-memory mutation (nor a version-mismatched plugin's silent load failure), so it
  correctly continues to report `[ ]` (not wired) until a skill is actually installed on
  disk via `install-skill` or a project's own `skills.paths` config — this task did not
  change `doctor`, since a live-registration probe is out of scope here.
