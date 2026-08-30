# Task 10 report — cross-adapter release verification

## Scope and baseline

- Worktree: `audit-remediation`
- Required starting/verified HEAD: `0a2b00e792660e926204254e818776e8c6822cd4`
- Merge-base for the whole-branch review package: `b8e4daa865691a9f0a735d1cc823270532c6d870`
- No publish, push, merge, version bump, ledger edit, or source correction was performed.
- The task brief and ledger were read from `.superpowers/sdd/PLAN/`; neither exists at the repository root.

## Verification evidence

Every command required by `task-10-brief.md` was run from this worktree.

### Focused invariant suites

```text
./node_modules/.bin/vitest run __tests__/core __tests__/policy.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts __tests__/mcp/tool-ops.test.ts __tests__/mcp/server.test.ts __tests__/pi.test.ts __tests__/opencode.test.ts __tests__/stats.test.ts
```

Result: exit 0; **12 test files passed, 589 tests passed**. No tests were skipped in this run.

### Static, runtime, build, and packed release checks

```text
./node_modules/.bin/tsc --noEmit
```

Result: exit 0, no diagnostics.

```text
./node_modules/.bin/vitest run
```

Result: exit 0; **21 test files passed, 727 tests passed**.

```text
pnpm run build
```

Result: exit 0 (`tsc -p tsconfig.build.json`).

```text
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
```

Result: exit 0; **2 test files passed, 9 tests passed**. The pack suite created and installed a real `predexec@0.4.0` tarball with `npm install --omit=dev`; its 30-file package contains compiled ESM entries, both binaries, skills/configs, and README, and the fresh install resolved `@modelcontextprotocol/server` while excluding the pi dev dependency. The installed CLI and MCP stdio initialize/list/call smoke tests passed.

## Scope and release-surface audit

Commands:

```text
git diff --check
git status --short --untracked-files=all
git log --oneline --decorate -15
```

`git diff --check` passed. Before this report was created, the worktree status was clean. The latest 15 commits are the Task 1–9 implementation/fix commits ending at `0a2b00e`; no Task 10 source correction was needed.

- `git diff b8e4daa..HEAD -- package.json pnpm-lock.yaml` is empty. Runtime dependencies remain exactly `@modelcontextprotocol/server` and `zod`; no production dependency was added.
- `core/` imports only Node built-ins (`node:child_process`, `node:fs`, `node:path`) and internal core modules. No harness package or third-party runtime import entered `core/`.
- `git ls-files dist` returns no entries and `git check-ignore -v dist/core/engine.js` identifies the repository's `dist/` ignore rule. Build output is present for local pack verification but is not staged/tracked.
- `PLAN.post-0.3.1-archive.md` and `CODEX-RESEARCH.md` are not tracked in either checkout. The main checkout still reports both as untracked; current SHA-256 observations are `97f742cb769ce36b6a7cf843067d5ac4e51d218e260cbbfdaa2493bc85094990` and `39857645bb81c4366fb9964d759d2d050bfb227522b47010ebe2836f31c17084`, respectively. They were not opened for editing or modified. The worktree does not contain either file.
- No `CLAUDE.md` exists in the repository/worktree; the shipped `configs/*/AGENTS.md`, `.pi/skills/*`, adapter descriptions, and README carry the documented routing invariants.

## Documentation truthfulness

### Working directory

`resolvePlanCwd` rejects non-string/empty, absolute, and lexical `..`-escaping plan cwd values before any operation runs. A valid nested cwd becomes the one effective `RunOptions.cwd` used by shell commands, `fileExists`, Pi native factories, and MCP tool operations. The shared `PLAN_CWD_DESCRIPTION` and README describe this as a relative directory inside the session root, with absolute/escaping paths rejected. This matches implementation and tests.

### Policy

The README and adapter descriptions accurately distinguish host coverage: opencode checks Bash plus supported native `read`/`grep`/`glob` shapes (with local `list` compatibility); Claude maps supported `Read`/`Grep`/`Glob` settings to native operations while subprocess Bash remains self-enforced; Codex's persisted checker is shell/Bash-only because it has no persisted native file-operation policy source; and Pi has no separate persisted policy checker. Deny/ask/prompt-equivalent matches hard-stop before execution as described.

### Truncation and resource bounds

Shell and tool capture set structural stdout/stderr completeness flags, retain the `OUTPUT_CAP` prefix plus an explicit marker, and aggregate those flags. Conditions reject unsafe absence/numeric/JSON in incomplete stdout, while positive prefix matches remain usable; engine warnings are flag-driven. Pi progress is capped and omitted when no update callback exists. Canonical plan prose exposes operation, concurrency, depth, cwd, and JSON-path limits. The user-facing docs make no claim that omitted output is complete, so no stale public truncation claim remains.

One deferred internal wording issue remains from Task 1: the `TRUNCATION_MARKER` comment in `core/runner.ts` says the engine checks marker text, although the engine correctly checks structural flags. This is non-behavioral and was not changed during a verification-only gate.

### Symlink containment

MCP explicit targets are lexically checked, then realpath-checked after existence. A target resolving outside the session root is rejected unless its lexical path contains an exact `node_modules` segment, preserving dependency-manager symlink farms. Recursive walks do not descend symlinked directories; search results are canonicalized and post-validated. README and MCP descriptions name both the exception and the remaining non-kernel-atomic pathname race, matching the implementation and accepted Task 7 boundary ruling.

## Whole-branch review package

The review input is pinned to the verified merge-base and HEAD:

```text
git diff b8e4daa865691a9f0a735d1cc823270532c6d870...HEAD
git log b8e4daa865691a9f0a735d1cc823270532c6d870..HEAD --oneline
```

The branch diff is **38 files, 3022 insertions, 512 deletions**, covering Tasks 1–9 and their reports. Existing per-task review packages are under `.superpowers/sdd/PLAN/review-*.diff`; this report records the final merge-base command and evidence for the final whole-branch reviewer. No collaboration/reviewer sub-agent facility is available in this worker, so final two-axis review adjudication remains for the parent agent's final gate.

## Residual concerns carried forward

These are documented/deferred findings from the completed task reports, not newly discovered release regressions:

- `resolvePlanCwd` accepts a relative cwd containing a NUL byte; the eventual spawn failure is less actionable than central cwd validation.
- A narrow false negative is possible when genuinely emitted marker-shaped text is removed from a structurally truncated stream; there is no symmetric stderr truncation regression test.
- Fallback grep context caching scales with requested context and returned matches; direct executor abort can theoretically race after the final read chunk; accelerated `rg` and fallback differ in legacy synthetic-terminal-line behavior.
- MCP pathname containment cannot be kernel-atomic against a malicious concurrent parent-directory rename/replacement with portable Node APIs; this is explicitly documented and accepted as outside the single-process threat model.
- The deferred runner comment noted above is documentation-only.

No residual concern was release-blocking under the brief's criteria during the
initial verification pass. The subsequent final-review gate is recorded below.

## Integration fix round 1 — Important findings

The final-review gate identified two integration regressions in the previously
verified adapter surface. This round started from
`0a2b00e792660e926204254e818776e8c6822cd4`.

### RED evidence

Before changing production code, the new regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/engine.test.ts __tests__/opencode.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 1; **19 tests failed, 216 passed**. The failures reproduced both
Important findings: five shared-inspection time-wrapper cases, five Claude
inner-command cases, five Codex inner-command cases, one engine normalization
case, one Claude nested-`Glob` case, and two OpenCode nested-`glob` cases (the
source and compiled plugin variants).

The root causes were isolated before the fix. `normalizePolicyOperation`
prefixed `find.pattern` as though it were a filesystem scope, so a nested plan
cwd changed the requested glob before OpenCode/Claude policy matching. The
shared wrapper stripper recognized `time` but did not consume its `-f`/
`--format` or `-o`/`--output` argument values; policy matching then saw the
option/value as the command head and missed the inner command.

### GREEN implementation and regressions

- Native policy normalization now prefixes only the operation's `path`; `find`
  patterns and grep patterns remain unchanged. The core regression also checks
  read, ls, grep path, grep pattern, and find path normalization together.
- `command-inspection.ts` now accepts wrapper-specific option-argument sets,
  consumes separate values, and recognizes attached `-fVALUE`/`-oVALUE` and
  `--format=VALUE`/`--output=VALUE` forms. Claude and Codex provide the `time`
  option set while retaining their own policy parsing, precedence, and verdict
  logic.
- OpenCode source and compiled-plugin e2e regressions and Claude engine policy
  regressions verify nested native glob rules match the requested pattern.

After the fixes, the focused regression command passed **235/235 tests** after
rebuilding the compiled artifacts. The broader invariant command:

```text
./node_modules/.bin/vitest run __tests__/core __tests__/policy.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts __tests__/mcp/tool-ops.test.ts __tests__/mcp/server.test.ts __tests__/pi.test.ts __tests__/opencode.test.ts __tests__/stats.test.ts
```

passed **603/603 tests**, and `./node_modules/.bin/tsc --noEmit` passed with no
diagnostics. The full suite passed **746/746 tests**. Release verification also
passed:

```text
pnpm run build
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
```

The build succeeded and the release suites passed **9/9 tests**, including the
real packed-install smoke checks. `git diff --check` passed. Only the owning
engine, shared command-inspection module, Claude/Codex policy adapters, and
their focused regressions changed; no ledger edit, dependency change, dist
staging, publish, push, merge, or version bump was performed.

## Integration fix round 2 — Important mutation bypass

This round started from the round-1 commit `c2e6143`. Final whole-branch
review identified that the new wrapper handling correctly reached the inner
command for policy matching but caused the mutation classifier to treat an
output-bearing `time` wrapper as the safe inner command. In particular,
`/usr/bin/time -o timing.log printf hi` could create `timing.log`.

### RED evidence

Before changing production code, the classifier and engine regressions were run
with:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts
```

Result: exit 1; **13 tests failed, 228 passed**. Eight classifier cases
returned `null` for `/usr/bin/time -o`, `time --output`, attached
`-ofile`/`--output=file`, `env time` chains, and `-a/--append` paired with
output. Five engine cases reached a successful leaf instead of stopping before
`runNode`; each timing-file assertion confirmed the bypass could execute.

### GREEN implementation and regressions

- `core/destructive.ts` now inspects leading wrapper chains for output-bearing
  `time` options before resolving the wrapped command head. It recognizes
  absolute `/usr/bin/time`, separate and attached short/long output options,
  `env time` chains, and append paired with output.
- Format-only `-f/--format`, `-p`, append without output, and safe inner
  commands remain allowed. The classifier returns a `time` output token for an
  actionable mutation hard-stop.
- Engine regressions prove all covered output forms stop before execution and
  do not create the timing file.

The focused mutation/engine suite passed **241/241 tests**. The combined
mutation, engine, command-inspection, and Claude/Codex/OpenCode policy suites
passed **382/382 tests**. `./node_modules/.bin/tsc --noEmit` passed, and
`pnpm run build` succeeded.

The full suite passed **763/763 tests**. Release verification passed **9/9
tests**:

```text
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
```

The packed-install smoke checks passed with the rebuilt production artifacts,
and `git diff --check` passed. No ledger edit, dependency change, version bump,
publish, push, merge, or release artifact staging was performed.

## Integration fix round 3 — Important mutation and wrapper bypasses

This round started from `a193f96`. Scoped review identified three related
Important bypasses: time-output detection stopped at options belonging to a
preceding `env`/`nice` wrapper, clustered GNU `time` flags such as `-ao` were
not interpreted, and a parenthesized command group hid its executable body
from the classifier.

### RED evidence

Before changing production code, the new regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts __tests__/command-inspection.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 1; **13 tests failed, 360 passed**. The failures covered
`env -u X /usr/bin/time -o`, `nice -n 5 /usr/bin/time -o`, clustered `-ao`
inspection and policy matching, parenthesized `/usr/bin/time` and `git add`
groups, and the corresponding engine no-file-creation cases.

### GREEN implementation and regressions

- `timeOutputOption` now walks the full leading wrapper chain using each
  wrapper's option/value grammar before resolving the wrapped command. This
  covers `env -u`, `nice -n`, absolute time paths, and output options after
  those wrappers.
- Shared command inspection recognizes argument-taking short options inside
  GNU-style clusters, so `time -ao timing.log curl ...` skips the output path
  and reaches the inner command for Claude/Codex policy matching.
- The destructive classifier recursively inspects quote-aware parenthesized
  groups while excluding arithmetic `(( ... ))` and quoted literal
  parentheses. Grouped `time -o`, `cp`, and `git add` commands now hard-stop.
- Safe `time -p`, format-only `-f/--format`, append-only options, and quoted
  literal parentheses remain non-mutating.

The focused mutation/engine/command-inspection/Claude/Codex policy suite passed
**373/373 tests**. `./node_modules/.bin/tsc --noEmit` passed and
`pnpm run build` succeeded. The full suite passed **779/779 tests**. Release
verification passed **9/9 tests**:

```text
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
```

The packed-install smoke checks passed with rebuilt artifacts and
`git diff --check` passed. No ledger edit, dependency change, version bump,
publish, push, merge, or release artifact staging was performed.
