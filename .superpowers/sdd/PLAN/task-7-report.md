# Task 7 RED/GREEN Report

## Scope

Task 7 makes MCP filesystem targets truthful across symlink boundaries. Existing
lexical containment remains the first check; existing targets are then checked
through realpath, with the package-manager dependency exception limited to an
exact lexical `node_modules` path segment.

Work started from `856242b12531bbbb4cc6dc31ccdc5351f6b6bc99`.

Changed files:

- `mcp/tool-ops.ts`
- `mcp/server.ts`
- `README.md`
- `__tests__/mcp/tool-ops.test.ts`
- `__tests__/mcp/server.test.ts`

## RED

Added real temporary-directory symlink tests before the production change:

- `root/link -> outside` must be rejected for `read link/secret.txt`, grep
  scoped to `link`, and `ls link` with a symlink-outside-root diagnostic.
- `root/node_modules/pkg -> outside/pkg` must remain readable as a dependency
  symlink.
- The MCP plan argument description must document that dependency symlinks below
  `node_modules` are the sole exception.

Focused RED command:

```text
./node_modules/.bin/vitest run __tests__/mcp/tool-ops.test.ts __tests__/mcp/server.test.ts
```

Observed before implementation: `3` failures. The read symlink escape returned
success with no containment diagnostic, the new server-description assertion was
absent, and the first fixture placement also exposed `link/` in an existing root
listing assertion. The fixture was moved to an isolated temporary root before
the implementation was completed, so no existing listing/parity behavior was
changed.

## GREEN

Implementation:

- Added asynchronous realpath resolution for both the configured root and every
  existing target after lexical locate/stat validation.
- Rejects resolved targets outside the canonical root unless the lexical path's
  segments include exactly `node_modules`; the error includes the required
  `symlink resolves outside the predexec root` text.
- Read, grep, find, and ls now operate on the validated real target. Recursive
  pure-Node walks retain their existing dirent behavior and do not descend into
  directory symlinks.
- Retains lexical paths separately so grep/find output remains stable under
  canonical path aliases such as macOS `/var` → `/private/var` and under
  dependency symlinks.
- Updated MCP authoring prose and README containment documentation with the
  dependency-symlink exception.

Focused GREEN command and result:

```text
./node_modules/.bin/vitest run __tests__/mcp/tool-ops.test.ts __tests__/mcp/server.test.ts
```

Passed: `2` files, `105/105` tests.

## Verification

```text
./node_modules/.bin/tsc --noEmit
```

Passed.

```text
./node_modules/.bin/tsc -p tsconfig.build.json
```

Passed.

```text
./node_modules/.bin/vitest run
```

Passed: `19` files, `695/695` tests.

```text
git diff --check
```

Passed with no whitespace errors.

## Residual considerations

- Lexical containment still rejects absolute paths that are outside the lexical
  session root even if they refer to the same object through an OS alias; this
  preserves the existing model-facing path contract.
- The only intentional realpath escape is a target whose lexical relative path
  contains an exact `node_modules` segment. Names such as `node_modules-evil`
  do not qualify.

## Fix round 1/5

### RED regression

Added a deterministic accelerator fixture that emits a match for a canonical
file under `root/alias`, then swaps the lexical `alias` symlink to an outside
directory before the executor formats context lines. Before the fix,
`formatMatches` reconstructed `resolve(base, m.path)`, reopened the swapped
alias, and returned the outside file's context instead of the scanned file.

```text
./node_modules/.bin/vitest run __tests__/mcp/tool-ops.test.ts
```

Observed: `86 tests | 1 failed`; the new test returned `outside-before` and
`outside-after` where the canonical file required `inside-before` and
`inside-after`.

### GREEN implementation

- `Match` now carries `canonicalPath` alongside its lexical display path.
- Both rg and the pure-Node fallback populate that field from the actual path
  scanned; context formatting groups and reads by `canonicalPath` only.
- Search results are rejected if an accelerator reports a canonical path outside
  the validated search scope or if that path no longer resolves canonically
  before formatting (including context-free results).
- Revalidation now runs immediately before grep/find operation work after local
  option/glob preparation.
- Pure-Node file scans recheck canonicality immediately before opening and use a
  `FileHandle` stream with `O_NOFOLLOW` where available. Aborted streams retain
  Task 6's `aborted` classification.
- Directory walks/listings use `opendir` handles, and recursive walks recheck
  each canonical directory before opening it; directory symlinks remain
  un-followed during recursion.

Focused GREEN command and result:

```text
./node_modules/.bin/vitest run __tests__/mcp/tool-ops.test.ts
```

Passed: `1` file, `86/86` tests.

### Remaining TOCTOU limitation

Node 22 does not expose a portable `openat`/`readdirat`-style API that lets this
adapter resolve every path component relative to a directory handle. A parent
directory can therefore still be renamed/replaced in the small interval between
the final realpath check and a pathname-based `opendir`/open, and the rg/fd
accelerators necessarily operate on pathnames. File handles stabilize data once
opened; canonical-path checks, `O_NOFOLLOW` on the final component, directory
handles, result-scope validation, and post-open canonical checks reduce the race
and prevent ordinary alias swaps, but they cannot provide kernel-atomic traversal
against a malicious concurrent renamer. The README documents this exact
single-process threat-model boundary.

### Fix-round verification

```text
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.build.json
./node_modules/.bin/vitest run
git diff --check
```

All passed after the fix round; final counts and commit are recorded in the
handoff message.
