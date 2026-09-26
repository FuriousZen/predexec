#!/usr/bin/env node
/**
 * Build wrapper: compiles into a scratch directory, then atomically swaps it
 * into place as `dist/`.
 *
 * Plain `tsc -p tsconfig.build.json` only ever ADDS or OVERWRITES files under
 * `dist/` — it never deletes one whose source moved or was removed. A file an
 * earlier source layout emitted (e.g. a pre-Task-5 `dist/command-inspection.js`,
 * from before that module moved into `core/shell/`) survives every later
 * build untouched and can ship inside a release tarball (see
 * __tests__/pack.test.ts's "every packaged dist/ .js file maps to a real
 * source .ts file" guard).
 *
 * A naive `rm -rf dist && tsc` fix has a real race: vitest runs many test
 * files in parallel worker processes, several of which import compiled
 * dist/ output directly or spawn bin/predexec-mcp.mjs (which hard-fails when
 * dist/ is missing) WHILE this script's forced rebuild (pack.test.ts /
 * release-hygiene.test.ts's ensureBuild({force:true})) is running — an rm-then-
 * recompile leaves dist/ absent (or, worse, present but incomplete) for the
 * multi-second duration of the tsc compile, which those concurrent tests
 * observe as a hard failure. Building into `dist.tmp` first and swapping it
 * in via same-filesystem `rename`s (each a single atomic directory-entry
 * update, not a data copy) means the well-known `dist/` name always points at
 * either the complete old build or the complete new one — never a hole.
 */
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const tmp = join(root, "dist.tmp");
const stale = join(root, `dist.stale-${process.pid}`);

// Leftovers from a previous crashed/killed build must not confuse this one.
rmSync(tmp, { recursive: true, force: true });
rmSync(stale, { recursive: true, force: true });

const tscBin = join(root, "node_modules", ".bin", "tsc");
const result = spawnSync(tscBin, ["-p", join(root, "tsconfig.build.json"), "--outDir", tmp], {
  stdio: "inherit",
  cwd: root,
});

if (result.status !== 0) {
  // A failed compile must leave the existing dist/ exactly as it was — half
  // of a broken build is worse than the stale-but-working one it would replace.
  rmSync(tmp, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

if (existsSync(dist)) renameSync(dist, stale);
renameSync(tmp, dist);
rmSync(stale, { recursive: true, force: true });
