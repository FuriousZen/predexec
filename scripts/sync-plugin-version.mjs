/**
 * Sync `.claude-plugin/plugin.json` `version` to package.json's.
 *
 * Run by the `version` lifecycle script during `npm version`, which bumps
 * ONLY package.json — without this hook the plugin manifest drifts (it sat at
 * 0.2.0 while package.json moved to 0.3.0). The lifecycle runs after the bump
 * and before npm's release commit, so the staged manifest lands in the same
 * commit. Guarded by __tests__/release-hygiene.test.ts. Dev-only: `scripts/`
 * is not in the package `files` allowlist.
 */
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const path = ".claude-plugin/plugin.json";
const plugin = JSON.parse(readFileSync(path, "utf8"));
plugin.version = version;
writeFileSync(path, JSON.stringify(plugin, null, 2) + "\n", "utf8");
console.log(`synced ${path} to ${version}`);
