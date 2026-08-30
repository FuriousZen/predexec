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

## Integration fix round 4 — Important shell-boundary bypasses

This round started from `207091ba7664b33badb0cafdff3192918865c861` after the
third integration-fix review. The new regressions covered clustered `env`
options and split-string payloads, non-parenthesized shell control syntax, and
commands hidden inside double-quoted substitutions.

### RED evidence

Before changing production code, the new focused regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/destructive.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 1; **15 tests failed, 327 passed**. The failures reproduced the
three boundary classes: clustered `env -iu`/`-iS` consumption, `env`-wrapped
time output, brace/`if` clauses, and mutation commands inside double-quoted
`$()`/backtick substitutions. The shared seam assertion also showed that
split-string payloads were not recursively inspected.

### GREEN implementation and regressions

- `command-inspection.ts` now has a bounded shell-clause extraction seam that
  removes only quote-aware leading control words/braces (`{`, `if`, `then`,
  `case`, and related reserved words), preserving quoted literals. Wrapper
  inspection now supports command-string options and basename-qualified
  wrapper paths.
- `core/destructive.ts` parses GNU-style `env` short clusters, separate and
  attached `-u`/`-C`/`-S`, and long equivalents. `-S`/`--split-string` payloads
  recurse through the same mutation/time-output classifier. Substitution
  bodies are recursively classified with a finite depth budget, and grouped
  shell clauses are inspected before the safe-tier decision.
- Claude and Codex policy checkers include the same extracted shell clauses in
  their existing raw/stripped matching union; their precedence, wrapper
  semantics, and single-quoted literal behavior remain unchanged.
- Focused destructive/engine/command-inspection/policy verification passed
  **406/406 tests**. `./node_modules/.bin/tsc --noEmit` passed with no
  diagnostics.

The full suite passed **812/812 tests**. `pnpm run build` succeeded, and the
release/pack suites passed **9/9 tests**, including packed-install smoke checks.
`git diff --check` passed. No ledger edit, dependency change, dist staging,
version bump, publish, push, merge, or release artifact staging was performed.

### Self-review

The changes are limited to the shared pure inspection seam, the core mutation
classifier, the two policy consumers, and focused regressions. The new tests
cover mutating and read-only grouped clauses, recursive and single-quoted
substitutions, clustered/separate/long `env` forms, and no-execution engine
guards. Existing read-only compound, quoted-literal, wrapper, precedence, and
packed-install tests remain green. Recursive shell inspection is bounded and
falls back conservatively for over-depth syntax; no policy precedence or
mutation wrapper behavior outside the requested boundaries was changed.

## Integration fix round 5 — final shell-boundary/fail-closed integration

This final allowed integration round started from `6c1940de68ca2a052ee79cca2f302ff35e292b77`.
It addressed the remaining shell parsing and bounded-inspection findings. No
ledger edit, version bump, publish, push, merge, or release-artifact staging was
performed.

### RED evidence

Before production changes, the new public-seam regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/destructive.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 1; **9 tests failed, 346 passed**. The failures reproduced
quote-insensitive `$()`/process-substitution extraction, absent completeness
signalling, missing `coproc`/case-branch extraction, silent mutation recursion
loss, Claude's quoted `time -f` value bypass, and the existing four-level
Claude/Codex policy traversal cutoff.

### GREEN implementation and fail-closed contract

- `command-inspection.ts` now uses a quote/escape-aware substitution lexer. It
  ignores parentheses inside single/double quotes and backticks, handles nested
  `$()` and process substitutions, and preserves the existing body-only
  `extractCommandSubstitutions` API. The explicit
  `inspectCommandSubstitutions` and `inspectCommandSubstitutionTree` seams report
  completeness and enforce depth, command-count, and character budgets.
- Core mutation classification now hard-stops with `complex shell syntax` for
  incomplete or over-budget executable substitutions. It recursively inspects
  every extracted body, case branch, named/unnamed coprocess body, and grouped
  clause before considering the safe tier. An un-decomposable case/coprocess
  construct cannot become SAFE.
- Claude and Codex policy checkers use the shared bounded substitution tree
  (32 levels, 512 inspected commands, and a 1 MiB aggregate character budget).
  Any incomplete/over-budget tree or control-clause inspection returns an
  actionable `incomplete shell syntax (policy inspection ...)` verdict instead
  of discarding pending bodies. Existing deny/prompt precedence and raw/stripped
  forms remain unchanged.
- Claude's raw wrapper stripper now tokenizes with quote-aware source spans and
  removes wrapper option arguments from the original string. Thus
  `time -f "%E %U" curl ...` reaches the inner command while preserving exact
  and glob rule spelling. Codex retains its argv-token behavior.
- `env` remains deliberately out of scope for host wrapper policy matching.
  The documented Claude/Codex wrapper vocabularies do not include `env`; this
  round does not invent policy semantics for it. Core mutation inspection still
  handles `env` as its own executable wrapper, including split-string payloads.

### GREEN verification

Focused destructive/engine/inspection/Claude/Codex verification:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/destructive.test.ts __tests__/core/engine.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 0; **5 test files, 423 tests passed**. This includes engine
no-execution guards for quoted substitutions, case branches, and coprocesses,
read-only case false-positive coverage, deep denied `curl` policy coverage, and
over-budget fail-closed policy coverage.

Additional required checks:

```text
./node_modules/.bin/tsc --noEmit
pnpm run build
./node_modules/.bin/vitest run
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

All passed: typecheck/build succeeded; the full suite passed **829/829 tests**;
release/pack passed **9/9 tests**, including packed-install CLI/MCP smoke
checks; and `git diff --check` passed.

### Residual concerns

The shell inspection remains intentionally bounded and heuristic rather than a
full shell parser. The explicit contract is conservative at the boundary:
malformed quotes/substitutions, unsupported case/coprocess decomposition, and
budget exhaustion stop speculation. Policy inspection may therefore stop a
command that a full shell parser would prove harmless, which is preferable to
silently allowing an uninspected executable body. No new production dependency,
host wrapper vocabulary, or policy precedence rule was introduced.

## Extended integration fix round 6 — malformed case and recursive control clauses

This user-authorized extension started from `d4ab61e64ee8c2427eb045650249cb7901363679`.
It addresses the two remaining Important findings from the fifth review round:
malformed `case` branches were reported complete after dropping an unterminated
body, and Claude/Codex policy matching expanded only one control-clause level.
No ledger edit, version bump, publish, push, merge, or release-artifact staging
was performed.

### RED evidence

Before changing production code, the focused regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/destructive.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 1; **23 tests failed, 362 passed**. The failures reproduced
first/middle/last malformed case branches, unmatched groups, and denied
commands nested in parenthesized, negated, conditional, case, and nested
control clauses for both policy adapters.

### GREEN implementation

- The shared command-inspection traversal now walks substitution bodies and
  executable control/group clauses recursively under depth, command-count, and
  character budgets. It tracks seen/queued bodies to avoid self-loop and
  duplicate expansion, and reports incomplete syntax before any pending body is
  silently discarded.
- Case extraction validates every branch's pattern/body delimiter and accepts
  `;;`, `;&`, and `;;&`; an unterminated or malformed branch is retained for
  diagnostics but marks the whole inspection incomplete. Quoted `esac` and
  terminator text remains literal. Arithmetic `(( ... ))` is excluded from
  executable-group extraction while substitutions inside it remain inspected.
- Claude and Codex consume the recursive shared tree directly, preserving their
  raw/stripped forms and existing deny/ask and most-restrictive precedence.
  Both adapters fail closed with actionable incomplete-shell results even when
  no restrictive rule is configured. Core mutation inspection uses the same
  structural preflight and remains fail closed on incomplete/over-budget
  executable syntax.

### GREEN verification

Focused security suites passed **385/385 tests**. The broader engine/policy
verification passed **254/254 tests**, and `./node_modules/.bin/tsc --noEmit`
passed with no diagnostics. The full suite passed **857/857 tests**.

```text
pnpm run build
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

Build succeeded; release/pack verification passed **9/9 tests**, including the
packed-install CLI/MCP smoke checks; and `git diff --check` passed.

### Self-review

The implementation is limited to the shared pure inspection seam, the core
mutation preflight, the Claude/Codex policy consumers, and focused regressions.
The bounded traversal is quote-aware, avoids arithmetic and quoted literals,
does not add wrapper vocabulary or alter host precedence, and preserves the
existing valid case/coprocess, substitution, read-only, and raw/stripped
matching tests. Malformed first/middle/last branches and unmatched executable
groups now fail closed instead of silently omitting bodies. Generated `dist/`
output remains ignored and unstaged; no runtime dependency, ledger, or release
metadata changed.
