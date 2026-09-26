# predexec escape hardening — 2026-09-26

Follow-up to the 0.5.0 harness refresh. Findings come from the 0.5.0 final review, its
re-review, and the controller probes run against the published `predexec@0.5.0`. All verdicts
below were measured with `isDestructiveCommand` from `dist/core/index.js`. The user accepted every
recommendation in this document, including the two design decisions in D1 and D2.

## F — flaky tests (reproduced by running three suites concurrently)

- **F1** — `__tests__/core/runner.test.ts:201` ("kills a command that exceeds commandTimeoutMs,
  including its children"). The test asserts `process.kill(childPid, 0)` throws the moment `runNode`
  returns. Under load, the SIGKILLed orphan has not yet been reaped. The kill is correct; the
  assertion is racy.
- **F2** — `__tests__/release-hygiene.test.ts:219`. The sync-plugin-version test plants
  `0.0.0-stale` into the real tracked manifests, runs the sync, and restores them. Concurrent runs
  therefore observe each other's stale value. Tests must never write to tracked files.

## W — `install-skill --dry-run` prints `installed: <path>`

`bin/predexec.mjs:1769` records `installed`/`overwritten` whether or not `dryRun` is set. Nothing
is actually written. Only the wording is wrong.

## E — read-only escapes (read-only on 0.5.0)

- **E-A: arithmetic over a data-derived variable.** In these forms bash evaluates the variable's
  VALUE as an arithmetic expression, so `c='a[$(cmd)]'` runs `cmd`:
  - `echo $((c))`, `(( c ))`, `let c`
  - `[[ c -eq 1 ]]`
  - `${a[c]}`, `${s:c:1}`
  - `declare -i n=c`

  Within one command, attacker-controlled values can only enter a variable through data: `$(…)`,
  backticks, `read`/`mapfile`/`readarray`, `printf -v`, `for x in <expansion>`, `getopts`, or
  expansion of another tainted variable. `x=5; echo $((x+1))` must stay read-only.
- **E-B: data-fed operands defeat deny rules.** Examples: `echo .env | xargs cat`,
  `while read f; do cat "$f"; done < list`, `cat $(cat names.txt)`. These are reads, but
  Claude/Codex/opencode/Antigravity deny rules can't see the operand. Ruling R27 already stops
  `$VAR` operands when Claude Read rules are active. This finding extends that treatment to xargs
  operands, read-loop bodies, and `$(…)` operands, for every host.
- **E-C: literal code fed to an interpreter via here-string/heredoc is not scanned.** Read-only
  today: `python3 <<< 'import os;os.remove("x")'`, `node <<< 'require("fs").rmSync("x")'`,
  `tclsh <<< 'exec id'`. perl here-strings are already caught. Stdin from a FILE
  (`python3 < x.py`) belongs to D1.
- **E-D: exec-capable tools and writers are read-only because unknown heads default to
  read-only.**
  - Exec-capable: `osascript -e`, `vim/view/ex -c '!…'` and `+'!…'`, `emacs --eval`/`-batch`,
    `gdb -ex`/`-x`, `expect -c`, `R -e`, `tclsh`/`wish`, `man -P`/`--pager`/`MANPAGER`,
    `flock … -c|cmd`.
  - Writers: `tar --index-file`/`--volno-file`/`--rsh-command`/`--rmt-command`, `split`,
    `csplit`, `mkfifo`.
  - Already caught (no change needed): `lua -e`, `Rscript -e`, `julia -e`, `sqlite3 .shell`,
    `git -c core.pager`.
- **E-E: Claude Read-rule reader list keeps missing readers.** `column`, `fold` and `expand` leak
  `.env` under `Read(./.env)`. Structural fix: check every path-like operand of every command
  against Read deny/ask rules, whatever the head. The same applies to Antigravity `read_file`
  grants.

## S — structural: unknown command heads default to MUTATING (allowlist inversion)

Every escape class above is a consequence of "unknown head ⇒ read-only". This finding inverts the
default:
- A curated read-only head list.
- Subcommand-aware lists for multi-tools (`git`, `cargo`, `npm`/`pnpm`/`yarn`, `kubectl`,
  `docker`, `go`, `pip`, `brew`, `gh`), read verbs only.
- A **user-level** extension list.
- An unknown head gives a `mutationStop` with reason `"unknown command <head>"`.

Measure the flip set over the command corpus before committing to the list.

## D — design decisions (user accepted the recommendations)

- **D1 (R15/R23)** — interpreters running repo files become mutating:
  - `python3 script.py`, `python3 -m <non-stdlib-reader>`
  - `node x.js`, `node --run`, `node --test`
  - `ruby x.rb`, `perl x.pl`
  - `python3 < x.py`, `deno run`, `bun x`, `npx`/`pnpm dlx`/`bunx`
  - `make`, `just`, `npm run`/`pnpm run`/`yarn <script>`, and similar task runners

  Inline one-liners stay governed by the existing reader allowlists. A **user-level opt-in**
  allowlist can re-enable specific commands or script paths.
- **D2 (R46)** — opencode v2 agent-file strictness is relaxed in exactly two ways, each validated
  by the Task 17a differential fuzzer against real js-yaml 3.14.2 (0 divergences required):
  - Plain (unquoted) keys inside `permission` maps may contain spaces and glob chars (`git *`),
    within js-yaml plain-key rules.
  - Top-level unquoted values are rejected only for `: ` (colon-space) or ` #`, not for any `:`.

  `doctor` names the agent file, line and reason when an agent goes deny-all.

## Security constraint on all allowlists

Allowlists that relax classification (S user list, D1 opt-in) are read ONLY from:
- the environment (`PREDEXEC_READONLY_HEADS`, `PREDEXEC_ALLOW_SCRIPTS`);
- a user-level config file (`$XDG_CONFIG_HOME/predexec/config.json`, default
  `~/.config/predexec/config.json`).

They are NEVER read from a file inside the repository or session root. A cloned repo must not be
able to allowlist `rm`.
