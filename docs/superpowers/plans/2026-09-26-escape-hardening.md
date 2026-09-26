# predexec Escape Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two flaky tests and the dry-run wording bug. Close every read-only escape class found after 0.5.0 (E-A..E-E). Invert the unknown-head default to mutating. Apply the two accepted design decisions: D1 (interpreters running repo files are mutating) and D2 (relaxed opencode v2 agent-file rules).

**Architecture:** Targeted classifier/policy fixes come first, test-first, each pinned by rows proven to fail before the fix. Then a shared, user-level-only config reader feeds opt-in allowlists into core through options (core stays pure). Then the head-default inversion lands behind a measured flip set. Docs and skills are regenerated last.

**Tech Stack:** Node.js 22+, TypeScript 5.9, Vitest 4, pnpm 11, `@modelcontextprotocol/server` 2.1, zod 4.

**Spec:** `docs/superpowers/specs/2026-09-26-escape-hardening.md`. Finding IDs (F1, F2, W, E-A..E-E, S, D1, D2) refer to it.

**Project context:** `../CLAUDE.md` (parent directory, outside this repo). Its Invariants and Hard-won details are binding.

## Global Constraints

- `core/` stays pure TypeScript, imports nothing outside `core/`, and has zero third-party runtime dependencies.
- Add no production dependency. The production closure stays `@modelcontextprotocol/server`, `@modelcontextprotocol/core` and `zod`.
- Read-only speculation: anything that writes, installs, deletes or execs hard-stops before running. Every new rule fails closed.
- Relaxing allowlists (user read-only heads, script opt-in) are read ONLY from env vars (`PREDEXEC_READONLY_HEADS`, `PREDEXEC_ALLOW_SCRIPTS`) and `$XDG_CONFIG_HOME/predexec/config.json` (default `~/.config/predexec/config.json`). They are never read from the repo or session root.
- The classifier and evaluator stay total: exception-safe and termination-safe.
- Host policy semantics are preserved:
  - opencode: last-match-wins.
  - Claude Code: deny → ask → allow.
  - Codex: most-restrictive-wins.
  - Antigravity: Deny > Ask > Allow.
- `mcp/server.ts` never writes to stdout. No root `.mcp.json`.
- Exit 2 means never-ran and exit 1 means ran-found-nothing, on every host.
- Skills are generated: edit `steering.ts`, then run `pnpm skills`. Never hand-edit a SKILL.md.
- Every behavior change starts with a failing test, observed failing for the expected reason.
- The corpus snapshot (`__tests__/core/destructive-corpus.test.ts`) may change only by read-only→mutating flips, and every flip must be listed in the task report. Any mutating→read-only flip is a defect.
- Focused tests: `./node_modules/.bin/vitest run <files>`. Typecheck: `./node_modules/.bin/tsc --noEmit`. Full gate: `pnpm run build && ./node_modules/.bin/vitest run`. Baseline is 3186 passed + 1 skipped, and the count only goes up.
- Work on branch `escape-hardening`. Stage with explicit `git add <paths>`. Use conventional commits. No push, no publish, no version bump.
- Tests never read or write the real `$HOME` config dirs. Point `HOME` and `XDG_CONFIG_HOME` at tmp dirs.

## Review Focus

1. **A variable that got its value from data and is later used in arithmetic.** The bypasses to check: the tainted variable passing through another variable, a nested `$((…))`, a quoted form, or an array subscript. Covered by Task 3.
2. **A file name that only exists at runtime.** Operands from `xargs`, read loops or `$(…)` must stop under deny rules on every host. Covered by Task 6.
3. **A command predexec doesn't recognize.** After Task 9 it must stop, while ordinary read-only exploration keeps working: `ls`, `cat`, `rg`, `git status/log/diff/show`, `jq`, `npm ls`, `cargo tree`, `kubectl get`. Covered by Task 9.
4. **A repo trying to allowlist itself.** A `config.json` or `.predexec.json` inside the repo must have no effect. Covered by Task 8.
5. **A relaxed opencode v2 agent file.** It must never produce allow where v2 denies. Covered by Task 10 (differential fuzzer).

---

### Task 0: Hygiene — archive the shipped plan, refresh project context

**Files:**
- Move: `PLAN.md` → `docs/superpowers/plans/2026-09-25-harness-refresh.md` (`git mv`)
- Modify: `../CLAUDE.md` (in place, not committed)
- Modify: `__tests__/release-hygiene.test.ts` if its path-hygiene test lists `PLAN.md`

- [ ] **Step 1: Archive the plan.** `git mv PLAN.md docs/superpowers/plans/2026-09-25-harness-refresh.md`. Update any test or doc that references `PLAN.md` so it points at the new path. The no-local-paths hygiene test must still cover it.
- [ ] **Step 2: Update `../CLAUDE.md`.**
  - The "Current state" header and Develop section should give the current test count (3186).
  - Replace the "PLAN.md is the active working plan" paragraph. The harness-refresh plan shipped as 0.5.0 and is archived at `docs/superpowers/plans/2026-09-25-harness-refresh.md`. The active plan is `docs/superpowers/plans/2026-09-26-escape-hardening.md`, and its spec is `docs/superpowers/specs/2026-09-26-escape-hardening.md`.
- [ ] **Step 3:** Run the full gate. Commit `chore: archive shipped harness-refresh plan`, including the new spec and plan docs under `docs/superpowers/`.

### Task 1: Flaky tests F1, F2 and a stress script

**Files:** `__tests__/core/runner.test.ts`, `scripts/sync-plugin-version.mjs`, `__tests__/release-hygiene.test.ts`, `package.json` (scripts only)

**Interfaces:** Produces `sync-plugin-version.mjs [--root <dir>]`, which defaults to the repo root. The `npm version` lifecycle keeps its current behavior.

- [ ] **Step 1 (F1):** In the termination test, replace the instantaneous `process.kill(childPid, 0)` throw assertion with a helper, `waitForProcessGone(pid, { timeoutMs: 2000, intervalMs: 20 })`. It resolves true once `kill(pid, 0)` throws ESRCH. Assert that it resolves true. Keep the exit-124 and timeout-notice assertions. Apply the same helper to any other test that asserts immediate process death (grep for `kill(` with `, 0)`).
- [ ] **Step 2 (F2) failing test:** In the release-hygiene suite, assert that the tracked manifests are byte-identical before and after the whole sync describe block. Also assert that the sync test passes when run twice concurrently: spawn two `node scripts/sync-plugin-version.mjs --root <tmpcopy>` processes against separate tmp copies, both succeed, and neither touches the repo. Watch it fail, or show why the old in-place approach is unsafe.
- [ ] **Step 3:** Add `--root` to the sync script. Rewrite every sync test to copy the manifests and `package.json` into a tmp dir and run the script with `--root <tmp>`. Tests never write tracked files.
- [ ] **Step 4:** Add `"test:stress": "node scripts/stress-test.mjs"`. The new script (plain JS, no deps) builds once, then runs N (default 3) `vitest run` processes concurrently. It prints each run's summary and exits non-zero if any run failed. Don't add it to the default `test`. Run it once and paste the result into the report.
- [ ] **Step 5:** Run the full gate, then commit `test: de-flake termination and plugin-sync tests; add stress runner`.

### Task 2: Dry-run wording (W)

**Files:** `bin/predexec.mjs` (around lines 1766-1770 and 1925-1935), `__tests__/install-skill.test.ts`

- [ ] **Step 1: Failing tests.**
  - `install-skill claude --dry-run` into a fresh tmp HOME prints `would install: <path>` and a final line `dry run — nothing written`, and the file does not exist afterwards.
  - With an existing differing file plus `--force --dry-run`, it prints `would overwrite:` and the file content is unchanged.
  - A non-dry-run still prints `installed:`.
- [ ] **Step 2:** Implement. The result actions are `would-install`/`would-overwrite` when `dryRun`; the CLI renders them as `would install`/`would overwrite`. Run the tests, then commit `fix(cli): install-skill --dry-run reports would-install, writes nothing`.

### Task 3: E-A — arithmetic over data-derived variables

**Files:** `core/shell/lexer.ts` (arithmetic context extraction), `core/destructive.ts` (pipeline hook), a new `core/shell/taint.ts`. Tests: `__tests__/core/shell/taint.test.ts` and `__tests__/core/read-only-heads.test.ts` rows.

**Interfaces:** Produces `findTaintedArithmetic(command: string): string | null` in `core/shell/taint.ts`. It returns a reason token such as `"arithmetic over data-derived variable c"`, or null.

- [ ] **Step 1: Failing rows.** All of these must be mutating:

  ```
  c=$(cat f); echo $((c))
  c=`cat f`; (( c ))
  read c < f; let c
  read -r c <<< "$x"; echo $((c+1))
  mapfile -t a < f; echo ${a[0]}; echo $((a))
  printf -v c '%s' "$(cat f)"; echo ${s:c:1}
  for c in $(cat f); do echo $((c)); done
  c=$(cat f); d=$c; echo $((d))
  c=$(cat f); [[ c -eq 1 ]]
  c=$(cat f); declare -i n=c
  c=$(cat f); echo ${arr[c]}
  c=$(cat f); echo $(( $c ))
  c=$(cat f); echo "$(( c * 2 ))"
  ```

  All of these must stay read-only:

  ```
  x=5; echo $((x+1))
  echo $((3*4))
  echo $((RANDOM % 10))
  n=$(wc -l < f); echo "$n"
  echo ${#arr[@]}
  ```

  The last one has no arithmetic over a tainted value.
- [ ] **Step 2: Implement.** Do a linear pass over the command's clauses using the existing lexer.
  - A variable becomes tainted when it is assigned from `$(…)`, backticks, `read`, `mapfile`/`readarray`, `printf -v`, a `for` over a non-literal list, `getopts`, or a tainted expansion.
  - Arithmetic contexts are `$((…))`, `((…))`, `let`, `[[ … -eq|-ne|-lt|-le|-gt|-ge … ]]` operands, indexed array subscripts, `${var:off:len}` offsets, and `declare`/`typeset -i` values.
  - A tainted identifier referenced as a bare name or `$name` inside an arithmetic context ⇒ mutating.
  - Stay linear-time. If the tracking can't be completed (a construct can't be parsed), fall back to "any arithmetic identifier in a command that contains any data-assignment construct" ⇒ mutating.
- [ ] **Step 3:** Run the core tests and the corpus snapshot, listing every flip. Then run the full gate and commit `fix(core): arithmetic over data-derived variables is mutating`.

### Task 4: E-C — here-string/heredoc payloads to interpreters

**Files:** `core/shell/interpreters.ts`, `core/shell/language-scan.ts`, `core/destructive.ts`. Tests: rows in `__tests__/core/read-only-heads.test.ts` or the interpreter test file.

- [ ] **Step 1: Failing rows.** All of these must be mutating:

  ```
  python3 <<< 'import os;os.remove("x")'
  node <<< 'require("fs").rmSync("x")'
  ruby <<< 'File.write("x","y")'
  python3 - <<'EOF'
  import os; os.remove("x")
  EOF
  tclsh <<< 'exec id'
  php <<< '<?php unlink("x");'
  ```

  These must stay read-only:

  ```
  python3 <<< 'print(1)'
  node <<< 'console.log(1)'
  ```

- [ ] **Step 2:** Implement. When an interpreter head (from the family normalization) has no `-c`/`-e` program and a here-string or heredoc supplies stdin, classify that literal text exactly like an inline program for that language. Include the `-` stdin marker. Interpreters with no reader allowlist (tclsh, wish, expect) treat any stdin program as mutating. `python3 < file` (stdin from a file) is left to Task 8. Run the tests and snapshot, then commit `fix(core): scan here-string/heredoc interpreter programs like -e/-c`.

### Task 5: E-D quick adds — exec-capable tools and missed writers

**Files:** `core/shell/heads.ts`, `core/shell/interpreters.ts`, `core/destructive.ts`. Test: `__tests__/core/read-only-heads.test.ts`.

- [ ] **Step 1: Failing rows (all must be mutating).**
  - `osascript -e 'x'` (any osascript invocation)
  - `vim -c '!id' f`, `vim +'!id' f`, `view -c '!id' f`, `ex -c '!id' f`, `nvim -c '!id' f`
  - `emacs --batch --eval '(x)'`, `emacs -batch -l f.el`
  - `gdb -batch -ex 'shell id'`, `gdb -x f`
  - `expect -c 'spawn id'`, `expect f.exp`
  - `R -e 'x'`, `R -f f.R`, `R --file=f.R`
  - `tclsh f.tcl`, `wish f.tcl`
  - `man -P 'sh -c id' ls`, `man --pager='x' ls`, `MANPAGER='sh -c id' man ls`
  - `flock /tmp/l -c 'rm x'`, `flock /tmp/l rm x`
  - `tar --index-file=o -tf a.tar`, `tar --volno-file=o -tf a`, `tar --rsh-command=/bin/sh -tf h:a`, `tar --rmt-command=x -tf h:a`
  - `split -l 10 f out`, `csplit f 5`, `mkfifo p`

  These must stay read-only: `vim --version`, `man ls`, `tar -tf a.tar`, `flock /tmp/l cat f`.

  For `flock` with a command, classify the embedded command recursively. `flock cat` is read-only only if its payload is.
- [ ] **Step 2:** Implement. Put each tool in its correct module: heads predicates for `tar`, `man`, `vim`-family and `flock`; interpreters for `osascript`, `emacs --eval`, `gdb`, `expect`, `R`, `tclsh`, `wish`; a writer list for `split`, `csplit`, `mkfifo`. Run the tests and snapshot, then commit `fix(core): classify exec-capable editors/debuggers/tools and missed writers`.

### Task 6: E-B — data-fed operands stop under deny rules on every host

**Files:**
- Create: `core/shell/operands.ts`
- Modify: `core/index.ts`, `mcp/policy-claude.ts`, `mcp/policy-codex.ts`, `policy.ts` (opencode, v1 and v2), `mcp/policy-antigravity.ts`
- Tests: each policy test file and a new `__tests__/core/shell/operands.test.ts`

**Interfaces:** Produces:

```ts
commandsWithUnresolvableOperands(command: string): Array<{ head: string; clause: string; reason: "xargs" | "read-loop" | "substitution-operand" | "variable-operand" }>
```

It is exported from `core/index.ts`.

- [ ] **Step 1: Failing tests.**
  - `operands.test.ts` covers:
    - `echo .env | xargs cat` ⇒ `{head:"cat", reason:"xargs"}`
    - `find . | xargs -0 grep x` ⇒ `grep`
    - `while read f; do cat "$f"; done < list` ⇒ `cat` via `read-loop`
    - `cat $(cat names.txt)` ⇒ `substitution-operand`
    - `cat "$f"` ⇒ `variable-operand`
    - `cat .env` ⇒ `[]`
  - Policy tests, one per host, each asserting a stop:
    - Claude: `Read(./.env)` and `Bash(cat .env)`.
    - Codex: forbidden `["cat",".env"]`.
    - opencode v1 and v2: `bash {"cat .env*":"deny"}`, and `read {".env":"deny"}` for v1.
    - Antigravity: `command(cat .env)` deny and `read_file(.env)` deny.

  Each host should stop `echo .env | xargs cat`, the read loop, and `cat $(cat names.txt)`.

  Plus the negatives: with no rule mentioning `cat` and no Read/read_file rules, `echo .env | xargs cat` runs normally.
- [ ] **Step 2:** Implement the rule on every host: an unresolvable operand for head H stops when the host has any deny or ask rule whose pattern could match an H command, or any path-read rule (Claude `Read()`, opencode `read`, Antigravity `read_file`). The stop reason says the operand can't be checked. For opencode v1 with `context.ask`, a static stop happens before any prompt. Keep each checker's existing semantics.
- [ ] **Step 3:** Run all policy tests and the full gate. Commit `fix(policy): stop commands whose operands come from data when host rules could match`.

### Task 7: E-E — path operands checked against read rules regardless of head

**Files:** `mcp/policy-claude.ts` (replace the reader-list gate with a generic path-operand check, keeping the reader list only for `<` redirects if still needed), `mcp/policy-antigravity.ts` (the same for `read_file` deny/ask), and tests.

- [ ] **Step 1: Failing tests.** With Claude `Read(./.env)` denied, each of `column .env`, `fold .env`, `expand .env`, `strings .env`, `unknowntool .env` and `git diff --no-index .env x` ⇒ policyStop. `echo hello` and `ls src` ⇒ allowed. Write the same cases for Antigravity `read_file(.env)`.
- [ ] **Step 2:** Implement. For every clause, take every non-option word, plus `--opt=value` values and redirect targets. If a word resolves to a path (relative to the effective cwd) matching a Read/read_file deny or ask rule, stop. Brace, glob and `$`-bearing words follow the existing R27/I2 unresolvable rules. Keep the previous reader-specific behavior as a subset, so no host verdict loosens. Run the tests, then commit `fix(policy): check every path operand against read rules, not just known readers`.

### Task 8: User-level config + D1 (interpreters running repo files are mutating)

**Files:**
- Create: `user-config.ts` at the repo root. It is harness-facing, not in core, and reads env plus `$XDG_CONFIG_HOME/predexec/config.json`.
- Modify: `core/types.ts` (a `ClassifierOptions` type and a `RunOptions.classifier?: ClassifierOptions` field), `core/destructive.ts`/`core/shell/interpreters.ts` (script rules), `core/engine.ts` (pass options), `adapter-runtime.ts` (load user config once per plan run and pass it)
- Modify: all adapters that call the classifier directly
- Tests: `__tests__/user-config.test.ts` and core rows

**Interfaces:** Produces:

```ts
interface ClassifierOptions {
  extraReadOnlyHeads?: readonly string[];   // Task 9 consumes
  allowScripts?: readonly string[];         // D1 opt-in: exact command prefixes or script paths
}
loadUserConfig(env?: NodeJS.ProcessEnv): { classifier: ClassifierOptions; warnings: string[] }
```

`isDestructiveCommand(command, options?)` gains the optional second argument. The config file format is `{ "readOnlyHeads": string[], "allowScripts": string[] }`. Env var entries are comma-separated.

- [ ] **Step 1: Failing tests (config).**
  - Env and XDG file entries are merged.
  - A malformed config file ⇒ warnings, and the options are empty (never throws).
  - A `config.json`, `.predexec.json` or `.config/predexec/config.json` inside a tmp repo passed as cwd/sessionRoot is IGNORED. Assert that `loadUserConfig` never reads under the session root. It takes no cwd argument at all.
  - `HOME` is set to a tmp dir.
- [ ] **Step 2: Failing rows (D1, all must be mutating by default).**

  ```
  python3 script.py
  python3 -m mypkg
  python3 < x.py
  node x.js
  node --run build
  node --test
  ruby x.rb
  perl x.pl
  deno run x.ts
  bun x.ts
  bun run build
  npx eslint .
  pnpm dlx x
  bunx x
  make
  make test
  just
  npm run lint
  pnpm run lint
  yarn lint
  cargo run
  go run .
  ```

  These must stay read-only:

  ```
  python3 -c 'print(1)'
  python3 -m json.tool f.json
  python3 --version
  node --version
  node -e 'console.log(1)'
  make -n
  npm ls
  cargo tree
  go version
  ```

  `python3 -m <mod>` stays read-only only for the existing stdlib reader-module set, such as `json.tool`.

  With `allowScripts: ["python3 scripts/report.py", "npm run lint"]` those exact prefixes become read-only, and the rest stay mutating.
- [ ] **Step 3:** Implement the loader, the options plumbing (core stays pure; the adapters load config via `adapter-runtime.ts`) and the D1 rules. The stop reason should read like `"runs repository script python3 script.py (allow via PREDEXEC_ALLOW_SCRIPTS or ~/.config/predexec/config.json)"`. Run the tests and snapshot (list every flip), then the full gate. Commit `feat: user-level config; interpreters running repo files are mutating (D1)`.

### Task 9: S — unknown heads default to mutating (allowlist inversion)

**Files:** `core/shell/heads.ts` (curated list plus per-subcommand lists), `core/destructive.ts` (default flip), the corpus snapshot, and tests.

**Interfaces:**
- Consumes: `ClassifierOptions.extraReadOnlyHeads` from Task 8.
- Produces: `READ_ONLY_HEADS` (curated) and `READ_ONLY_SUBCOMMANDS: Record<string, ReadonlySet<string> | predicate>`.

- [ ] **Step 1: Measure first.** Before changing behavior, add a scratch analysis (not committed) that runs the corpus plus a realistic exploration set of about 150 commands. Cover:
  - coreutils readers, `rg`/`fd`/`jq`/`yq`
  - git read verbs
  - `npm`/`pnpm`/`yarn` `ls`/`view`/`outdated`/`why`, `cargo tree`/`metadata`/`--version`
  - `go list`/`version`/`env`, `pip list`/`show`/`freeze`, `brew list`/`info`
  - `kubectl get`/`describe`/`logs`, `docker ps`/`images`/`inspect`/`logs`, `gh pr view`/`list`, `gh issue view`
  - `uname`/`whoami`/`date`/`env`/`printenv`/`which`/`type`/`command -v`, `tree`, `du`, `df`, `ps`, `lsof`, `file`, `stat`, `wc`, `sort`, `uniq`, `diff`, `cmp`, `md5sum`/`sha*sum`, `realpath`, `dirname`, `basename`

  Record which commands would flip read-only→mutating under a pure default flip. Put the table in the report.
- [ ] **Step 2: Failing tests.**
  - Every command in the realistic exploration set stays read-only.
  - Unknown heads ⇒ mutating with reason `unknown command <head>`: `foo`, `./bin/tool`, `somecli --list`, `terraform plan`, `aws s3 ls`.
  - `extraReadOnlyHeads: ["terraform plan","aws s3 ls"]` ⇒ read-only.
  - The multi-tool subcommand lists hold: `git push` is mutating, `npm install` is mutating, `kubectl apply` is mutating, `docker run` is mutating, and `gh pr merge` is mutating.
- [ ] **Step 3: Implement.** Build the curated lists from Step 1. The classifier returns `unknown command <head>` when a clause's effective head (after wrappers/assignments) is not in the read-only set and matches no subcommand list or user extension. Shell builtins and keywords (`echo`, `printf`, `test`, `[`, `true`, `false`, `cd`, `pwd`, `read` into locals, `for`/`while`/`if`/`case`, `export` of non-dangerous names) are handled explicitly. Update the corpus snapshot and list every flip; there must be no mutating→read-only flips. Run the full gate.
- [ ] **Step 4:** Commit `feat(core)!: unknown command heads are mutating; curated and user-extendable read-only lists`.

### Task 10: D2 — opencode v2 agent-file relaxation + doctor diagnostics

**Files:** `yaml-frontmatter.ts`, `policy.ts` (the v2 path, only if reason plumbing is needed), `bin/predexec.mjs` (opencode doctor), tests. The differential fuzzer lived in the scratchpad (`rr4/fuzz.mjs`, `rr5/fuzz2.mjs`). Re-create it as a committed dev-only script `scripts/probes/yaml-fuzz.mjs`, excluded from `files`. It uses js-yaml 3.14.2 from a scratch install, not a dependency; if that proves necessary, make it a devDependency.

- [ ] **Step 1: Failing tests.**
  - `permission:\n  bash:\n    git *: allow\n    rm -rf *: deny` parses with those plain keys.
  - `model: openrouter/x:free` and `description: see https://x.y/z` are accepted.
  - `description: a: b` (colon-space) still deny-alls, and so does ` #` in a plain value.
  - Every R45 rule not relaxed here still holds.
- [ ] **Step 2:** Implement exactly the two relaxations. Keep the parser linear and the caps unchanged.
- [ ] **Step 3: Differential validation.** Run the fuzzer with at least 4 seeds × 100k documents, weighted toward permission maps with plain keys and colon-bearing values. It must show 0 accepted-but-divergent documents versus js-yaml. Paste the results into the report. If any divergence appears, narrow the relaxation until there are 0.
- [ ] **Step 4: Doctor.** When a v2 agent file goes deny-all, `predexec doctor` lists `[!] opencode agent <file>:<line>: <reason> — every predexec call for agent <name> will stop`. Add a test with a tmp HOME and project.
- [ ] **Step 5:** Run the full gate, then commit `feat(opencode): relax v2 agent frontmatter for glob keys and colon values; doctor names deny-all agents`.

### Task 11: Steering, skills and docs

**Files:** `steering.ts` (then `pnpm skills`), `README.md`, `../CLAUDE.md` (in place), `configs/*/AGENTS.md` if they state classification rules.

- [ ] **Step 1:** Update the steering text:
  - Unknown commands and repo scripts now stop, and the model should run them via the host's shell tool.
  - Operands built from data (`xargs`, loops, `$(…)`) stop under deny rules.
  - Users can extend the read-only set only through `PREDEXEC_READONLY_HEADS`/`PREDEXEC_ALLOW_SCRIPTS` or `~/.config/predexec/config.json`.

  Keep it concise, per the "minimize explicit prompting" invariant. Regenerate the skills; the drift test must pass.
- [ ] **Step 2: README.** Add a "Configuration" section covering the config file, env vars, and the security note that repo files can't extend it. Update the classification description, and add a 0.6.0 behavior-change note (unknown heads and scripts now stop).
- [ ] **Step 3: `../CLAUDE.md`.**
  - Layout: add `user-config.ts`, `core/shell/taint.ts` and `core/shell/operands.ts`.
  - Remove the resolved open questions (R15/R23 → D1, R46 → D2) and record the decisions.
  - Add hard-won bullets: the allowlist inversion, user-level-only config, and arithmetic taint.
  - Update the test count and the known gaps.
- [ ] **Step 4:** Run the full gate, `npm pack --dry-run` and `node bin/predexec.mjs doctor`, and paste the summaries. Commit `docs: 0.6.0 classification model, configuration, and skills`.

## Execution order

`0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11`, run sequentially. Task 9 depends on Task 8's options, and Task 11 depends on everything before it.
