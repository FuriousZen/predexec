# predexec harness-refresh audit — 2026-09-25

Aggregated from seven parallel read-only audits of predexec 0.4.1 (HEAD `bbc33ab`):
core, pi, opencode, Claude Code, Codex, Antigravity (research), and build/deps/docs.
Repro scripts referenced below lived in the session scratchpad; each finding here is
restated precisely enough to be re-derived from a failing test.

Tags: **C** = confirmed by running code, **P** = plausible from reading, **V** = verified
against host source/docs, **U** = unverified (needs live measurement).

## Harness compatibility verdicts

| Harness | Tested against | Verdict |
|---|---|---|
| pi | `@earendil-works/pi-coding-agent` 0.87.1 (installed dev 0.82.1) | Compatible. Typechecks and loads via pi's real `loadExtensions()`. No breaking API changes 0.83–0.87. |
| opencode | `@opencode-ai/plugin`/`sdk` 1.18.32 (local binary 2.0.16) | Compatible with the v1 plugin shape. A v2 plugin API (`default:{id, effect\|setup}`) exists in source but is not wired into the session path yet — watch item. Host still pins zod 4.1.8. |
| Claude Code | current docs; `@modelcontextprotocol/server` 2.1.0 (locked 2.0.0) | Compatible. Permission syntax unchanged. Plugin MCP tools are namespaced `mcp__plugin_<plugin>_<server>__<tool>`. |
| Codex | codex-cli 0.154.0 local, 0.157.1 latest | Compatible; `readOnlyHint` skips approval in default `Auto` mode. Codex now supports skills + plugins; `env_vars=["CODEX_HOME"]` now forwards CODEX_HOME (CLAUDE.md claim is stale). |
| Antigravity | `agy` 1.2.10 local + antigravity.google docs | Not supported yet. MCP via `~/.gemini/config/mcp_config.json`; grants `action(target)` Deny>Ask>Allow in `~/.gemini/antigravity-cli/settings.json`; skills in `.agents/skills/` + `~/.gemini/config/skills/`; plugins bundle MCP+skills. |

## Requirement: every harness loads its prompting as a SKILL.md

| Harness | Today | Gap |
|---|---|---|
| pi | `.pi/skills/predexec/SKILL.md` via `pi.skills` | Tool-op syntax + guidelines still inlined in `promptGuidelines` (`.pi/extension/index.ts:253-257`); no sync test with `steering.ts`. |
| Claude Code | `skills/predexec-claude/SKILL.md`, plugin-only | README's recommended `claude mcp add` path installs no skill; no `marketplace.json` so plugin is uninstallable except `--plugin-dir`; skill names `mcp__predexec__predexec`, wrong under plugin namespacing; doctor never checks skill. |
| opencode | `system.transform` injection + `configs/opencode/AGENTS.md` | No skill. opencode discovers `.opencode/skills`, `~/.config/opencode/skills`, `.claude/skills`, `.agents/skills`, and config `skills.paths`; a plugin `config` hook can append `skills.paths` (V, source; U, live). |
| Codex | `configs/codex/AGENTS.md` drop-in | No skill. Codex discovers `~/.agents/skills`, `$CODEX_HOME/skills`, `.codex/skills`, `.agents/skills`, `/etc/codex/skills`, plugin skills. Plugins: `.codex-plugin/plugin.json` + marketplace. |
| Antigravity | none | Skills at `.agents/skills/<n>/SKILL.md`, global `~/.gemini/config/skills/` (conflicting doc says `~/.gemini/antigravity-cli/skills/` — U). |

## Findings

### Core (`core/`, `command-inspection.ts`)
- **CORE-1 HIGH C** — read-only heads that write/exec (`core/destructive.ts:220-247`): `sed -n 'w F'`, `sort --output=F`, awk `print | "sh"` and `"cmd" | getline`, `xxd in out`, `rg --pre ./x.sh`, `tree -o F` all executed via `runPlanTree` with stoppedReason `leaf`. Also (P, GNU) `find -fprint/-fls/-okdir`, `sed --in-place`/`-Ei`/`1e cmd`, `sort -oF`/`--compress-program`, `gawk -i inplace`, `yq -i`, `xxd -r a b`, `less -o`.
- **CORE-2 HIGH C** — `isSafeRegex` bypass (`core/conditions.ts:416-435`): `((a+))+$`, `(a+b?)+$`, `(\w+\s?)+$`, `(a+){12}$` pass; exponential (24 chars ≈ 700 ms).
- **CORE-3 HIGH C** — shell commands inherit an open stdin and have no timeout (`core/runner.ts:124-128`): `cat`, `grep foo`, `tail -f`, `sleep 100` hang the walk.
- **CORE-4 MED C** — wrapper lists drifted: core `WRAPPERS` (`destructive.ts:1609`) lacks `timeout`, `stdbuf`, `noglob` that `command-inspection.ts:22` has → `timeout 5 node -e "fs.writeFileSync(...)"` read-only.
- **CORE-5 MED C** — interpreter-eval scan misses `os.replace`, `__import__('os').system`, `IO.write` (`destructive.ts:258-267`).
- **CORE-6 LOW C** — double capping reports wrong "N more chars" (`runner.ts:135, 227-231`).
- **CORE-7 LOW C** — `splitCommandSegments` ignores backslash escapes (masked by clause extraction today).
- **CORE-8 LOW P** — parallel results mislabelled after abort (`runner.ts:67, 220`).
- **CORE-9 LOW P** — `fileExists` condition accepts absolute / `..` paths outside session root (`conditions.ts:560`).
- **CORE-10 LOW** — per-chunk `toString()` mangles split UTF-8 (`runner.ts:143`); stale comment `runner.ts:16`; `stats.ts:87` duplicates `estimateRequestsSaved`; `coercePlan` mutates input.
- **ARCH-1** — core imports `../command-inspection.ts` (`core/destructive.ts:20-25`, `core/index.ts:21`): violates the "core is self-contained" invariant in letter.
- **ARCH-2** — three shell lexers across `destructive.ts` and `command-inspection.ts`; CORE-4 and CORE-7 are drift bugs from this.
- **ARCH-3** — `destructive.ts` is 2,497 lines: ~1,200 are interpreter-payload scanning, plus a git classifier; classifier recurses via `extractShellCommandClauses` twice (`:2385-2394`).
- **ARCH-4** — condition-kind list, tool list, jsonPath message, native-tool prefixes defined in 3–4 places each.
- **ARCH-5** — `checkOperationPolicy` is synchronous (`engine.ts:86-88`), blocking host-native permission bridges (opencode `context.ask`).

### pi
- **PI-1 MED C** — `coercePlan` never runs: pi validates args against `parameters` before `execute`, rejecting stringified `nodes`/whole-plan/`commands:"ls"`. Fix via `prepareArguments` (exists 0.82.1+).
- **PI-2 MED C** — tool-op failure returns exit 1 == "no matches" (`index.ts:209, 213, 224`); observed with broken `~/.pi/agent/bin/rg` (Linux ELF on macOS → ENOEXEC). MCP already uses exit 2.
- **PI-3 LOW** — `stoppedReason:"error"` returned as success; pi requires throwing for failed results.
- **PI-4 LOW** — nudge appended to errored bash results; ignores new `powershell` tool.
- **PI-5 LOW** — no `peerDependencies` for runtime import of `@earendil-works/pi-coding-agent` (pi docs require `"*"` peer).
- **PI-6 LOW** — no real-host test (loader, skill loader, arg validation).
- Env note: user's `~/.pi/agent/bin/{rg,fd}` are Linux binaries → pi's own grep/find broken on this Mac.

### opencode
- **OC-1 HIGH C** — `policy.ts:105,113` reads only `perm.bash ?? perm["*"]`; opencode flattens all keys in config order with wildcard key matching. `{bash:"allow","*":"deny"}` on `ls` → predexec allow, opencode deny.
- **OC-2 HIGH C** — config files concatenated (`policy.ts:188-194`) instead of opencode's remeda `mergeDeep` (first-appearance key order). Global `{"*":"allow","cat *":"deny"}` + project `{"*":"allow"}` → opencode denies `cat secret.pem`, predexec allows.
- **OC-3 MED C** — trailing `" *"` not optional (`"git log *"` deny misses bare `git log`); no `~/`/`$HOME` expansion.
- **OC-4 MED** — missing sources: `agent.<name>.permission`, built-in defaults (`external_directory: ask`, `.env` read ask), managed config dirs, `OPENCODE_CONFIG_DIR`/`_CONTENT`/`DISABLE_PROJECT_CONFIG`, `~/.opencode/`, wrong `OPENCODE_CONFIG` precedence; `cat ~/.ssh/id_rsa` runs where opencode asks `external_directory`.
- **OC-5 MED** — find: server rejects `limit>200` (core allows 1000) → exit 1; `truncated` never true → silent truncation at exactly `limit`.
- **OC-6 MED** — per-subdirectory `directory` param boots a new opencode instance each (config/plugins/LSP reload).
- **OC-7 LOW** — binary `file.read` returns base64 as stdout exit 0.
- **OC-8 LOW** — `system.transform` injects into title/summary/small-model prompts.
- Opportunity: plugin `context.ask({permission, patterns, always, metadata})` bridges to the host's real permission service — the long-term replacement for static policy parsing (needs ARCH-5).

### Claude Code
- **CC-1 HIGH C** — `mcp/tool-ops.ts:302` exempts any `node_modules` path from realpath containment: committed symlink `node_modules/evil -> /etc` reads `/etc/hosts`.
- **CC-2 HIGH C** — Read rules compiled with Bash-glob semantics, not gitignore (`policy-claude.ts:174-203, 419-455`): bare names don't match at depth, `secrets/**` deny misses nested, `//abs`, `~/`, `/`-anchored forms untranslated, no path normalization, no symlink-target check, path-scoped Read rules not applied to grep/find.
- **CC-3 MED C** — Read deny rules not applied to shell reads (`cat .env`, `cat < .env`) — CC applies them.
- **CC-4 MED** — managed sources missing: `~/.claude/remote-settings.json`, macOS MDM `com.anthropic.claudecode`, Windows `HKLM/HKCU\SOFTWARE\Policies\ClaudeCode`.
- **CC-5 MED** — skill names `mcp__predexec__predexec`; wrong under plugin namespacing.
- **CC-6 LOW** — plugin.json lacks `author`; npx spec unpinned (skill/server drift); doctor ignores `CLAUDE_CONFIG_DIR`; doctor local-scope match only on exact cwd.
- CLAUDE.md "Tool ops bypass non-bash permissions" gap is stale: `server.ts:204-211` wires a native checker (partially).

### Codex
- **CX-1 HIGH C** — Codex's own UI writes `network_rule(...)` into `default.rules` and `[[skills.config]]` into `config.toml`; predexec's extractor/`toml-lite` reject both → fail-closed refuses *every* command. Also rejected: inline tables, `"""` strings, dotted keys, `\u` escapes, `1_000`, `1e5`, `host_executable(...)`.
- **CX-2 HIGH** — trust/rules lookup uses only `projects[resolve(cwd)]` and `<cwd>/.codex/rules` (`policy-codex.ts:497-528`); Codex checks cwd → project root (`project_root_markers`, default `.git`) → main worktree root, canonicalized, and loads `.codex/` for every dir root→cwd. Subdir/symlinked sessions skip repo `forbidden` rules.
- **CX-3 MED** — `/etc/codex/rules` (system layer) never read.
- **CX-4 MED** — CODEX_HOME not forwarded → custom CODEX_HOME with no `~/.codex` = no enforcement (`policy-codex.ts:486`).
- **CX-5 MED** — `bash -lc 'cat .env'`, `sh -c`, `/bin/cat .env` evade a `forbidden ["cat",".env"]` rule; Codex splits simple `bash -lc` scripts.
- **CX-6 LOW** — alternatives in first pattern position → empty pattern (over-block); backslash escapes not unescaped (under-block); `"*"` treated as wildcard (Codex: literal).
- **CX-7 LOW** — toml-lite merges duplicate `[a]` headers; README:310 `curl -o AGENTS.md` clobbers user file; dangling `CODEX-RESEARCH.md` citations (`policy-codex.ts:6,17,133`, `bin/predexec.mjs:684`).

### Antigravity (design inputs)
- MCP config `{"mcpServers":{name:{command,args,env,cwd,disabled,disabledTools}}}`; `agy mcp add [--env K=V] <name> <cmd> -- [args]` (V).
- Unconfigured MCP calls prompt; grants `mcp(server/tool)`, `mcp(server/*)` (V). `readOnlyHint` effect U.
- Permissions: `~/.gemini/antigravity-cli/settings.json` `permissions.{allow,deny,ask}`, `command(prefix|regex:pat|*)`, `read_file(...)`, Deny>Ask>Allow; `toolPermission` ∈ `always-proceed|request-review|strict|proceed-in-sandbox`; `allowNonWorkspaceAccess`; App/IDE grants not readable from disk (V/U).
- Plugins: `~/.gemini/config/plugins/<n>/{plugin.json, mcp_config.json, skills/, rules/AGENTS.md}`, `agy plugin install|validate` (V). Plugin MCP tools may be namespaced (U).
- Open measurements: server cwd/env, `readOnlyHint`, MCP sandboxing, real global skills path, plugin tool namespacing vs `mcp(predexec/*)` grants, App/IDE grant storage.

### Build / deps / docs
- **ENV-1 HIGH** — host `node_modules` was installed in the Linux devcontainer (only `@rolldown/binding-linux-arm64-gnu`); `vitest` can't start on macOS. Clean macOS install: 1592 pass / 1 skip.
- **BLD-1 MED** — tests fail on fresh clone without `dist/` (`__tests__/pi.test.ts:42`, stdio tests in `mcp/server.test.ts`); no vitest `globalSetup`.
- **DEP-1** — latest: MCP server 2.1.0 (lock 2.0.0; includes id-0 cancellation fix relevant to `extra.mcpReq.signal`), zod 4.6.5 (lock 4.4.3), pi 0.87.1, TS 7.0.2 / vitest 5.0.2 (majors — defer). Prod closure 3 packages, `pnpm audit --prod` clean. zod rationale in CLAUDE.md is wrong: host pnpm does re-resolve; narrowing can't match opencode's 4.1.8 anyway.
- **DOC-1** — CLAUDE.md: "616 tests" (actual 1593), layout omits `command-inspection.ts`, `plan-language.ts`, `core/validation.ts`, `mcp/toml-lite.ts`, `docs/`; "PLAN.md removed" false; old PLAN.md has 50 unchecked boxes though "closed"; tracked `.superpowers/sdd/PLAN/task-*-report.md` noise; `pnpm-workspace.yaml` holds placeholder `allowBuilds` and stale excludes.
