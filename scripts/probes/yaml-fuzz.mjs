#!/usr/bin/env node
/**
 * Differential fuzzer: yaml-frontmatter.ts (predexec's certainty-or-fail-closed
 * reader for opencode v2 agent frontmatter) versus real js-yaml 3.14.2, the
 * YAML engine gray-matter 4 runs (`yaml.safeLoad(str)`), which is what opencode
 * v2 parses agent markdown with.
 *
 * Contract checked: for every document our reader ACCEPTS, js-yaml's safeLoad
 * (behind gray-matter's empty-block shortcut: a block with nothing but `#`
 * lines is `{}` without a parse) must also succeed and return a deep-equal value (same key order, same
 * scalar types). A document we reject is never a divergence — rejection is
 * the fail-closed direction. Divergences are printed and the exit code is 1.
 *
 * Dev-only probe; not shipped (package.json `files` excludes scripts/), not a
 * dependency. Manual setup, once:
 *
 *   mkdir -p /tmp/yaml-fuzz && cd /tmp/yaml-fuzz && npm init -y && npm install js-yaml@3.14.2
 *
 * Run (from the repo root; Node >= 22.18 strips the .ts types natively):
 *
 *   JS_YAML=/tmp/yaml-fuzz/node_modules/js-yaml node scripts/probes/yaml-fuzz.mjs [seeds] [docsPerSeed]
 *
 * `seeds` is a comma list (default `1,2,3,4`), `docsPerSeed` defaults to 100000.
 * The generator is weighted toward `permission` maps with plain glob keys and
 * top-level values carrying `:` — the two R46 relaxations.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";

const jsYamlPath = process.env.JS_YAML;
if (!jsYamlPath) {
  console.error("set JS_YAML to an installed js-yaml@3.14.2 package directory (see header)");
  process.exit(2);
}
const yaml = createRequire(import.meta.url)(resolve(jsYamlPath));
if (!yaml.safeLoad || !String(yaml.dump).length) throw new Error("JS_YAML is not js-yaml 3.x");
const { parseFrontmatter, parseYamlSubset } = await import(new URL("../../yaml-frontmatter.ts", import.meta.url).href);

const seeds = (process.argv[2] ?? "1,2,3,4").split(",").map(Number);
const perSeed = Number(process.argv[3] ?? 100_000);

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deep equality with key order and scalar type; prototypes ignored. */
function same(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date || b instanceof Date) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i] || !same(a[ka[i]], b[kb[i]])) return false;
  return true;
}

function run(seed) {
  const r = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const chance = (p) => r() < p;

  // Fragments: mostly benign so plenty of documents are accepted, plus every
  // character class a reader might disagree on.
  const WORDS = ["git", "rm", "ls", "cat", "npm", "run", "src", "log", "status", "x", "a", "b", "free", "openrouter", "gpt-4o", "v2", "true", "false", "null", "yes", "no", "on", "off", "y", "n", "1", "0", "10", "3.5", "1e3", "0x1f", "010", ".inf", "~", "2024-01-01", "1:30", "NaN"];
  const GLOB = ["*", "**", "?", "/", ".", "-", "_", "~", "!", "[a-z]", "{a,b}", "=", "+", "@", "%", "&", "$", "^", "(", ")", "|", ">", "<", "<<", ";", "\\", "`", ",", "[", "]", "{", "}"];
  const RISKY = [":", ": ", " :", "::", "#", " #", " # c", "'", '"', "''", "\t", "\u00a0", "é", "  ", " ", "---", "...", "- ", "? ", "&a", "*a", "!!str ", "|", ">", "%"];
  const token = (riskP) => (chance(riskP) ? pick(RISKY) : chance(0.3) ? pick(GLOB) : pick(WORDS));
  const phrase = (n, riskP, sepP = 0.5) => {
    let s = "";
    for (let i = 0; i < n; i++) s += (i && chance(sepP) ? " " : "") + token(riskP);
    return s;
  };
  const globKey = () => phrase(1 + Math.floor(r() * 4), 0.08, 0.6);
  const colonValue = () => {
    const forms = [
      () => `${pick(["openrouter", "anthropic", "openai", "google"])}/${pick(WORDS)}:${pick(["free", "beta", "1", "x"])}`,
      () => `see https://${pick(WORDS)}.${pick(["com", "y", "io"])}/${pick(WORDS)}`,
      () => `${pick(WORDS)}:${pick(WORDS)}`,
      () => `${phrase(2, 0.1)}:${phrase(1, 0.1)}`,
      () => phrase(1 + Math.floor(r() * 5), 0.15),
    ];
    return pick(forms)();
  };
  const action = () => (chance(0.9) ? pick(["allow", "deny", "ask"]) : token(0.3));
  const quote = (s) => (chance(0.5) ? `"${s.replace(/["\\]/g, "")}"` : `'${s.replace(/'/g, "''")}'`);
  const key = (inPerm) => {
    if (inPerm) return chance(0.12) ? quote(globKey()) : globKey();
    return chance(0.85) ? pick(["description", "model", "mode", "hidden", "steps", "temperature", "color", "prompt", "variant", "tools", "top_p", "options"]) : phrase(1, 0.3);
  };
  const flowMap = (inPerm, depth) => {
    const n = 1 + Math.floor(r() * 3);
    const items = [];
    for (let i = 0; i < n; i++) items.push(`${key(inPerm)}: ${depth < 1 && chance(0.2) ? flowMap(inPerm, depth + 1) : action()}`);
    return `{${items.join(chance(0.8) ? ", " : ",")}}`;
  };

  const lines = [];
  const nTop = 1 + Math.floor(r() * 5);
  for (let i = 0; i < nTop; i++) {
    if (chance(0.45)) {
      const pad = chance(0.9) ? "  " : pick([" ", "   ", "\t"]);
      if (chance(0.2)) {
        lines.push(`permission: ${flowMap(true, 0)}`);
        continue;
      }
      lines.push("permission:");
      const tools = 1 + Math.floor(r() * 3);
      for (let t = 0; t < tools; t++) {
        const tool = pick(["bash", "edit", "read", "webfetch", "external_directory", "*", "shell"]);
        const tk = tool === "*" ? '"*"' : tool;
        if (chance(0.25)) {
          lines.push(`${pad}${tk}: ${chance(0.5) ? action() : flowMap(true, 0)}`);
          continue;
        }
        lines.push(`${pad}${tk}:`);
        const rules = 1 + Math.floor(r() * 4);
        for (let k = 0; k < rules; k++) {
          const tail = chance(0.08) ? pick([" # c", " #c", "#c"]) : "";
          lines.push(`${pad}${pad}${key(true)}:${chance(0.95) ? " " : ""}${action()}${tail}`);
        }
      }
      continue;
    }
    const k = key(false);
    const v = chance(0.6) ? colonValue() : chance(0.5) ? phrase(1 + Math.floor(r() * 3), 0.2) : chance(0.5) ? quote(colonValue()) : flowMap(false, 0);
    lines.push(`${k}: ${v}`);
  }
  // Occasional structural damage.
  if (chance(0.1) && lines.length) {
    const i = Math.floor(r() * lines.length);
    const op = Math.floor(r() * 4);
    if (op === 0) lines.splice(i, 0, lines[i]);
    else if (op === 1) lines[i] = ` ${lines[i]}`;
    else if (op === 2) lines.splice(i + 1, 0, `  ${phrase(1, 0.3)}`);
    else lines[i] = lines[i].replace(": ", pick([":", " : ", ":  ", ": # c\n  "]));
  }
  return lines.join("\n");
}

let totalDocs = 0;
let totalDiv = 0;
const shown = [];
console.log(`js-yaml ${yaml.safeLoad && (await import("node:fs")).readFileSync(resolve(jsYamlPath, "package.json"), "utf8").match(/"version":\s*"([^"]+)"/)[1]}`);
for (const seed of seeds) {
  const r0 = mulberry32(seed * 7919);
  let accepted = 0;
  let acceptedPlainPermKey = 0;
  let acceptedTopColon = 0;
  let jsThrew = 0;
  let unequal = 0;
  let permOnlyEqual = 0;
  for (let d = 0; d < perSeed; d++) {
    const doc = run(Math.floor(r0() * 2 ** 31));
    let ours;
    try {
      ours = parseYamlSubset(doc);
    } catch {
      continue;
    }
    accepted++;
    // The file-level split must agree with the bare YAML read.
    const fm = parseFrontmatter(`---\n${doc}\n---\nbody\n`).data;
    const permKeys = [];
    const walk = (o, depth) => {
      if (!o || typeof o !== "object" || Array.isArray(o) || depth > 2) return;
      for (const [k, v] of Object.entries(o)) {
        permKeys.push(k);
        walk(v, depth + 1);
      }
    };
    walk(ours.permission, 0);
    const unquoted = (k) => doc.includes(`${k}:`) && !doc.includes(`"${k}"`) && !doc.includes(`'${k}'`);
    const isPermPlainKey = permKeys.some((k) => !/^[A-Za-z_][\w-]*$/.test(k) && unquoted(k));
    const isTopColon = Object.entries(ours).some(([k, v]) => typeof v === "string" && v.includes(":") && doc.includes(`${k}: ${v}`));
    if (isPermPlainKey) acceptedPlainPermKey++;
    if (isTopColon) acceptedTopColon++;
    let theirs;
    let threw = null;
    try {
      // gray-matter 4.0.3 index.js:101-110: a block that is empty once lines
      // starting with `#` are removed yields `{}` without calling the engine.
      theirs = doc.replace(/^\s*#[^\n]+/gm, "").trim() === "" ? {} : yaml.safeLoad(doc);
    } catch (err) {
      threw = err;
    }
    let bad = null;
    if (threw) {
      jsThrew++;
      bad = `js-yaml threw: ${threw.message.split("\n")[0]}`;
    } else if (!same(ours, theirs) || !same(fm, theirs)) {
      if (theirs && same(ours.permission, theirs.permission)) permOnlyEqual++;
      unequal++;
      bad = `ours=${JSON.stringify(ours)} js-yaml=${JSON.stringify(theirs)}`;
    }
    if (bad && shown.length < 20) shown.push({ seed, doc, bad });
  }
  const div = jsThrew + unequal;
  totalDocs += perSeed;
  totalDiv += div;
  console.log(
    `seed ${seed}: docs ${perSeed}, accepted ${accepted} (plain-key permission ${acceptedPlainPermKey}, top-level colon value ${acceptedTopColon}), ` +
      `divergent ${div} (js-yaml threw ${jsThrew}, unequal ${unequal}, of which permission-map equal ${permOnlyEqual})`,
  );
}
for (const s of shown) console.log(`\n--- divergence (seed ${s.seed}) ---\n${s.doc}\n>>> ${s.bad}`);
console.log(`\ntotal: ${seeds.length} seeds x ${perSeed} docs = ${totalDocs}, accepted-but-divergent ${totalDiv}`);
process.exit(totalDiv === 0 ? 0 : 1);
