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
