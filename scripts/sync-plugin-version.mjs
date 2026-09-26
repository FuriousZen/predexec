/**
 * Sync `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` to
 * package.json's version.
 *
 * Run by the `version` lifecycle script during `npm version`, which bumps
 * ONLY package.json — without this hook the plugin manifest drifts (it sat at
 * 0.2.0 while package.json moved to 0.3.0). The lifecycle runs after the bump
 * and before npm's release commit, so the staged manifests land in the same
 * commit. Guarded by __tests__/release-hygiene.test.ts. Dev-only: `scripts/`
 * is not in the package `files` allowlist.
 *
 * plugin.json's inlined MCP server also pins its `npx --package=predexec@…`
 * arg to the same version, so `npx -y --package=predexec@<stale>` never
 * resolves a version the plugin's own manifest has since moved past.
 * marketplace.json gets the version on its top-level (marketplace-manifest)
 * `version` field, not on the plugin entry — the entry's own `version` field
 * would take a back seat to plugin.json's per the docs ("When plugin.json
 * also sets version, plugin.json takes precedence and `claude plugin
 * validate` warns"), so setting it there would just be dead weight.
 */
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;

const pluginPath = ".claude-plugin/plugin.json";
const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
plugin.version = version;
const npxArgs = plugin.mcpServers?.predexec?.args;
if (Array.isArray(npxArgs)) {
  const i = npxArgs.findIndex((a) => typeof a === "string" && a.startsWith("--package=predexec"));
  if (i !== -1) npxArgs[i] = `--package=predexec@${version}`;
}
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n", "utf8");

const marketplacePath = ".claude-plugin/marketplace.json";
const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
marketplace.version = version;
writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n", "utf8");

console.log(`synced ${pluginPath} and ${marketplacePath} to ${version}`);
