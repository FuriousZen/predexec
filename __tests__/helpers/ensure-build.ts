/**
 * Cross-PROCESS build serialization for tests that need a fresh `dist/`.
 *
 * vitest runs test files in separate worker processes by default. Two files
 * whose `beforeAll` both shell out to `npm run build` (release-hygiene.test.ts
 * and pack.test.ts) can end up running that build concurrently against the
 * SAME `dist/` output tree — partial-write reads, doubled build cost, a flake
 * vector. An in-process mutex can't fix this because the two calls aren't in
 * the same process; an advisory filesystem lock (a directory, created with
 * `mkdirSync`, which is atomic even across processes) is what's needed.
 *
 * A lock older than STALE_LOCK_MS is assumed to belong to a crashed/killed
 * process and is stolen rather than waited on forever.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK_DIR = join(root, "node_modules", ".predexec-build.lock");
const STALE_LOCK_MS = 120_000;
const LOCK_POLL_MS = 100;
const LOCK_TIMEOUT_MS = 60_000;

function sleepSync(ms: number): void {
  // beforeAll here is synchronous (execSync-based), so polling needs a
  // synchronous sleep — Atomics.wait on a throwaway buffer blocks the
  // event loop deliberately, same trick Node itself has no async-free
  // alternative for.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      let age = 0;
      try {
        age = Date.now() - statSync(LOCK_DIR).mtimeMs;
      } catch {
        // Lock disappeared between our failed mkdirSync and this stat
        // (the holder released it) — retry immediately.
        continue;
      }
      if (age > STALE_LOCK_MS) {
        try {
          rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch {
          // Lost the race to steal it — fall through and retry.
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`ensureBuild: timed out waiting for build lock at ${LOCK_DIR}`);
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

function releaseLock(): void {
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // Already gone — fine.
  }
}

function isStale(): boolean {
  const distMain = join(root, "dist", ".opencode", "plugins", "predexec.js");
  const source = join(root, ".opencode", "plugins", "predexec.ts");
  // .opencode/package.json pins the NodeNext emit format for this one file
  // (see CLAUDE.md "hard-won details") — its mtime is a staleness input too,
  // so a change to it (e.g. reverting the "type":"module" pin) forces a
  // rebuild rather than silently reusing a stale dist/.
  const typeMarker = join(root, ".opencode", "package.json");

  if (!existsSync(distMain)) {
    return true;
  }
  const distMtime = statSync(distMain).mtimeMs;
  if (statSync(source).mtimeMs > distMtime) {
    return true;
  }
  if (existsSync(typeMarker) && statSync(typeMarker).mtimeMs > distMtime) {
    return true;
  }
  return false;
}

/**
 * Ensure `dist/` reflects current sources, serialized across processes.
 *
 * `force: true` (pack.test.ts) always rebuilds once the lock is held, because
 * packing must be fresh regardless of mtimes. Plain `ensureBuild()`
 * (release-hygiene.test.ts) rebuilds only when the staleness check says to —
 * cheap when another worker already rebuilt while this one waited for the lock.
 */
export function ensureBuild(opts?: { force?: boolean }): void {
  acquireLock();
  try {
    if (opts?.force || isStale()) {
      execSync("npm run build", { cwd: root, stdio: "pipe" });
    }
  } finally {
    releaseLock();
  }
}
