#!/usr/bin/env node
/**
 * Stress-runs the full vitest suite N times concurrently, to catch flake that
 * only shows up under load (shared real files, timing-sensitive assertions,
 * races between workers) — the class of bug behind F1/F2
 * (docs/superpowers/specs/2026-09-26-escape-hardening.md). A single `vitest
 * run` doesn't contend with anything else for CPU or for the tracked repo
 * files the way a real concurrent invocation (e.g. two contributors' CI jobs,
 * or a controller running multiple full gates at once) does.
 *
 * Builds once up front (so every concurrent run shares the same dist/ and the
 * build itself isn't racing N vitest processes against clean-build.mjs's own
 * atomic swap), then spawns N `vitest run` processes at once. Prints each
 * run's own summary line and exits non-zero if any run failed.
 *
 * Not part of the default `test` script — this is an on-demand, slower,
 * multi-minute check (`pnpm test:stress`), not something every `pnpm test`
 * pays for.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const runCount = Number(process.argv[2] ?? process.env.STRESS_N ?? 3);
if (!Number.isInteger(runCount) || runCount < 1) {
  console.error(`invalid run count: ${process.argv[2] ?? process.env.STRESS_N}`);
  process.exit(1);
}

const vitestBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vitest.cmd" : "vitest",
);
if (!existsSync(vitestBin)) {
  console.error(`vitest binary not found at ${vitestBin} — run pnpm install first`);
  process.exit(1);
}

function runOne(index) {
  return new Promise((resolvePromise) => {
    const child = spawn(vitestBin, ["run"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", (code) => resolvePromise({ index, code, output }));
  });
}

console.log(`[stress] building once (node scripts/clean-build.mjs)...`);
const build = spawnSync(process.execPath, [join(repoRoot, "scripts", "clean-build.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) {
  console.error(`[stress] build failed with exit code ${build.status}`);
  process.exit(build.status ?? 1);
}

console.log(`[stress] running ${runCount} concurrent \`vitest run\` processes...`);
const started = Date.now();
const results = await Promise.all(Array.from({ length: runCount }, (_, i) => runOne(i)));
const elapsedS = ((Date.now() - started) / 1000).toFixed(1);

let anyFailed = false;
for (const { index, code, output } of results.sort((a, b) => a.index - b.index)) {
  const testFilesLine = output.match(/^\s*Test Files\s+.*$/m)?.[0]?.trim() ?? "(no Test Files summary line)";
  const testsLine = output.match(/^\s*Tests\s+.*$/m)?.[0]?.trim() ?? "(no Tests summary line)";
  const status = code === 0 ? "PASS" : "FAIL";
  if (code !== 0) anyFailed = true;
  console.log(`[stress] run ${index + 1}/${runCount}: ${status} (exit ${code})`);
  console.log(`         ${testFilesLine}`);
  console.log(`         ${testsLine}`);
  if (code !== 0) {
    console.log(`--- run ${index + 1} output (failure) ---`);
    console.log(output);
    console.log(`--- end run ${index + 1} output ---`);
  }
}

console.log(`[stress] ${runCount} runs finished in ${elapsedS}s — ${anyFailed ? "AT LEAST ONE FAILED" : "all passed"}`);
process.exit(anyFailed ? 1 : 0);
