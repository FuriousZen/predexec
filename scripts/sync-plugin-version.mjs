/**
 * Sync the Claude Code and Codex plugin manifests to package.json's version.
 *
 * Run by the `version` lifecycle script during `npm version`, which bumps
 * ONLY package.json — without this hook the plugin manifests drift (Claude's
 * sat at 0.2.0 while package.json moved to 0.3.0). The lifecycle runs after
 * the bump and before npm's release commit, so the staged manifests land in
 * the same commit. Guarded by __tests__/release-hygiene.test.ts. Dev-only:
 * `scripts/` is not in the package `files` allowlist.
 *
 * Claude: `.claude-plugin/plugin.json`'s inlined MCP server pins its
 * `npx --package=predexec@…` arg to the same version, so
 * `npx -y --package=predexec@<stale>` never resolves a version the plugin's
 * own manifest has since moved past. `.claude-plugin/marketplace.json` gets
 * the version on its top-level (marketplace-manifest) `version` field, not on
 * the plugin entry — the entry's own `version` field would take a back seat
 * to plugin.json's per the docs ("When plugin.json also sets version,
 * plugin.json takes precedence and `claude plugin validate` warns"), so
 * setting it there would just be dead weight.
 *
 * Codex: `.codex-plugin/plugin.json`'s `version` field, and the npx pin in
 * its companion `.codex-plugin/mcp.json` (Codex's `mcpServers` manifest field
 * is a path to a separate file, not inlined — see docs/research/codex-plugin.md
 * §1). Codex's marketplace schema (`.agents/plugins/marketplace.json`) has no
 * top-level `version` field at all (confirmed against every installed
 * marketplace inspected — see docs/research/codex-plugin.md §1), so there is
 * nothing to sync there.
 *
 * Antigravity: `antigravity-plugin/plugin.json`'s `version` field, and the npx
 * pin in its sibling `antigravity-plugin/mcp_config.json` — agy's own
 * `plugin.json` schema documents only `name` (see
 * ~/.gemini/antigravity/builtin/skills/agy-customizations/docs/plugins.md,
 * read-only), but `agy plugin validate antigravity-plugin` accepts the extra
 * `version`/`description` fields, so keeping them in step with package.json
 * costs nothing and matches the Claude/Codex manifests' shape.
 */
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;

function syncNpxPin(args, version) {
  if (!Array.isArray(args)) return;
  const i = args.findIndex((a) => typeof a === "string" && a.startsWith("--package=predexec"));
  if (i !== -1) args[i] = `--package=predexec@${version}`;
}

const claudePluginPath = ".claude-plugin/plugin.json";
const claudePlugin = JSON.parse(readFileSync(claudePluginPath, "utf8"));
claudePlugin.version = version;
syncNpxPin(claudePlugin.mcpServers?.predexec?.args, version);
writeFileSync(claudePluginPath, JSON.stringify(claudePlugin, null, 2) + "\n", "utf8");

const marketplacePath = ".claude-plugin/marketplace.json";
const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
marketplace.version = version;
writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n", "utf8");

const codexPluginPath = ".codex-plugin/plugin.json";
const codexPlugin = JSON.parse(readFileSync(codexPluginPath, "utf8"));
codexPlugin.version = version;
writeFileSync(codexPluginPath, JSON.stringify(codexPlugin, null, 2) + "\n", "utf8");

const codexMcpPath = ".codex-plugin/mcp.json";
const codexMcp = JSON.parse(readFileSync(codexMcpPath, "utf8"));
syncNpxPin(codexMcp.mcpServers?.predexec?.args, version);
writeFileSync(codexMcpPath, JSON.stringify(codexMcp, null, 2) + "\n", "utf8");

const antigravityPluginPath = "antigravity-plugin/plugin.json";
const antigravityPlugin = JSON.parse(readFileSync(antigravityPluginPath, "utf8"));
antigravityPlugin.version = version;
writeFileSync(antigravityPluginPath, JSON.stringify(antigravityPlugin, null, 2) + "\n", "utf8");

const antigravityMcpPath = "antigravity-plugin/mcp_config.json";
const antigravityMcp = JSON.parse(readFileSync(antigravityMcpPath, "utf8"));
syncNpxPin(antigravityMcp.mcpServers?.predexec?.args, version);
writeFileSync(antigravityMcpPath, JSON.stringify(antigravityMcp, null, 2) + "\n", "utf8");

console.log(
  `synced ${claudePluginPath}, ${marketplacePath}, ${codexPluginPath}, ${codexMcpPath}, ` +
    `${antigravityPluginPath}, and ${antigravityMcpPath} to ${version}`,
);
