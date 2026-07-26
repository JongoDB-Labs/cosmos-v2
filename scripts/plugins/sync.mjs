#!/usr/bin/env node
/**
 * Plugin composition (ADR 0003 / plugin SDK).
 *
 * Composes the private plugin repos checked out under `plugins/<slug>/` into this
 * cosmos-v2 tree at build time, WITHOUT their code ever being committed to the
 * (public) core repo. For each plugin it:
 *   1. overlays `overlay/**` onto the repo (mirrors cosmos-v2 paths: src/plugins/<slug>
 *      + the (plugin-<slug>) route shims),
 *   2. appends `prisma/<slug>.prisma` after the `// @plugin-schema-fragments` marker,
 *   3. injects each declared back-relation after the `// @plugin-backrel:<Model>` marker,
 *   4. merges `plugin.json.dependencies` into package.json and refreshes
 *      package-lock.json (the Dockerfile runs `npm ci`, which fails hard when the two
 *      disagree — a plugin cannot ship its own package.json, so this is the only way
 *      for it to declare a runtime dependency),
 *   5. (re)generates src/lib/plugins/registry/{index,server}.ts to register the manifests
 *      + server hooks + integration providers.
 * Every path it writes is added to `.git/info/exclude` so a plugin's client code can
 * never be accidentally committed to the public core. `--clean` reverses it all.
 *
 * The public core with NO `plugins/` dir composes to the neutral (zero-plugin) build.
 * Run: `node scripts/plugins/sync.mjs`  (or `--clean`).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, copyFileSync, rmSync, rmdirSync, appendFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { mergeDependencies } from "./merge-deps.mjs";
import { camelSlug } from "./slug.mjs";

/** Run git with an argument array (no shell — safe for paths with (), [], spaces). */
const git = (args, opts = {}) => execFileSync("git", args, { cwd: ROOT, ...opts });

const ROOT = process.cwd();
const PLUGINS_DIR = join(ROOT, "plugins");
/** Resolve a git path properly: `.git` is a FILE in a worktree (it holds
 *  `gitdir: …`), so joining onto <root>/.git raises ENOTDIR there. */
const gitPath = (flag) => git(["rev-parse", "--path-format=absolute", flag]).toString().trim();
// `exclude` lives in the COMMON dir — git only ever reads that one, shared across
// worktrees. The state file is per-worktree, so two worktrees composing different
// plugin sets don't clobber each other's --clean manifest.
const EXCLUDE = join(gitPath("--git-common-dir"), "info", "exclude");
const STATE = join(gitPath("--git-dir"), "plugin-sync.state");   // real composed paths (for --clean)
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
const REG_INDEX = "src/lib/plugins/registry/index.ts";
const REG_SERVER = "src/lib/plugins/registry/server.ts";
const MARK = "# --- plugin-sync managed (do not commit) ---";
/** Escape gitignore metacharacters + anchor to root: exclude entries are matched as
 *  globs, so a literal path like `.../[orgId]/...` needs its []*? escaped. */
const excludeEntry = (p) => "/" + p.replace(/([[\]*?])/g, "\\$1");

const clean = process.argv.includes("--clean");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Read the previously-composed paths (real, unescaped) from the state file and
 *  drop our .git/info/exclude block + the state file. */
function removeManagedExclude() {
  if (existsSync(EXCLUDE)) {
    const lines = readFileSync(EXCLUDE, "utf8").split("\n");
    const i = lines.indexOf(MARK);
    if (i !== -1) writeFileSync(EXCLUDE, lines.slice(0, i).join("\n").replace(/\n+$/, "\n"));
  }
  if (!existsSync(STATE)) return [];
  const managed = readFileSync(STATE, "utf8").split("\n").filter(Boolean);
  rmSync(STATE, { force: true });
  return managed;
}

function restore() {
  const managed = removeManagedExclude();
  const tracked = [];
  const dirs = new Set();
  for (const rel of managed) {
    const abs = join(ROOT, rel);
    // tracked core files we overwrote (schema, registries) → git checkout; overlaid
    // plugin files are untracked → delete.
    let isTracked = false;
    try { git(["ls-files", "--error-unmatch", rel], { stdio: "ignore" }); isTracked = true; } catch { /* untracked */ }
    if (isTracked) tracked.push(rel);
    else if (existsSync(abs)) { rmSync(abs, { force: true }); for (let d = dirname(rel); d && d !== "."; d = dirname(d)) dirs.add(d); }
  }
  // prune now-empty overlaid dirs, deepest first
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try { rmdirSync(join(ROOT, d)); } catch { /* not empty / gone */ }
  }
  if (tracked.length) {
    // Un-hide before restoring: the compose skip-worktree'd these tracked core files
    // (schema + registries) so their composed content never shows as committable.
    git(["update-index", "--no-skip-worktree", ...tracked]);
    git(["checkout", "--", ...tracked]);
  }
  console.log(`[plugin-sync] cleaned ${managed.length} composed path(s)`);
}

if (clean) { restore(); process.exit(0); }

// Fresh compose: always start from a clean base.
restore();

if (!existsSync(PLUGINS_DIR)) {
  console.log("[plugin-sync] no plugins/ dir — neutral (zero-plugin) build");
  process.exit(0);
}

const slugs = readdirSync(PLUGINS_DIR).filter((d) => existsSync(join(PLUGINS_DIR, d, "plugin.json")));
if (slugs.length === 0) { console.log("[plugin-sync] no plugins found"); process.exit(0); }

const written = new Set();       // repo-relative paths we wrote (to exclude)
const manifests = [];            // { slug, importPath }
let schemaFragments = "";
const backrel = {};              // Model -> [lines]
const pluginDeps = [];           // { slug, dependencies } — npm deps to merge

// Which repo paths are TRACKED in core (collision guard: an overlay must never
// silently clobber a real core file).
const trackedSet = new Set(
  git(["ls-files"]).toString().split("\n").filter(Boolean),
);

for (const slug of slugs) {
  const dir = join(PLUGINS_DIR, slug);
  const cfg = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
  // 1) overlay
  const overlayRoot = join(dir, cfg.overlay ?? "overlay");
  for (const abs of walk(overlayRoot)) {
    const rel = relative(overlayRoot, abs);            // e.g. src/plugins/<slug>/x.ts
    if (trackedSet.has(rel)) throw new Error(`[plugin-sync] ${slug}: overlay path collides with a tracked core file: ${rel}`);
    const dest = join(ROOT, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    written.add(rel);
  }
  // 2) schema fragment
  const frag = join(dir, cfg.schemaFragment ?? `prisma/${slug}.prisma`);
  if (existsSync(frag)) schemaFragments += `\n// ===== plugin:${slug} =====\n` + readFileSync(frag, "utf8").trimEnd() + "\n";
  // 3) back-relations
  for (const [model, lines] of Object.entries(cfg.schemaBackRelations ?? {})) {
    (backrel[model] ??= []).push(...lines.map((l) => `  ${l}`));
  }
  // 4) npm dependencies (a plugin can't ship a package.json — see merge-deps.mjs)
  if (cfg.dependencies) pluginDeps.push({ slug, dependencies: cfg.dependencies });
  // 5) registration
  const importPath = "@/" + (cfg.manifest ?? `src/plugins/${slug}/manifest.ts`).replace(/^src\//, "").replace(/\.ts$/, "");
  const serverPath = "@/" + (cfg.serverHooks ?? `src/plugins/${slug}/server.ts`).replace(/^src\//, "").replace(/\.ts$/, "");
  manifests.push({ slug, importPath, serverPath });
}

// --- write schema (inject fragments + back-relations at the markers) ---
let schema = readFileSync(SCHEMA, "utf8");
for (const [model, lines] of Object.entries(backrel)) {
  const marker = `  // @plugin-backrel:${model}`;
  if (!schema.includes(marker)) throw new Error(`[plugin-sync] missing schema marker: ${marker}`);
  schema = schema.replace(marker, marker + "\n" + lines.join("\n"));
}
schema = schema.replace(
  "// @plugin-schema-fragments — composed plugin models/enums are appended below this line by scripts/plugins/sync.mjs",
  (m) => m + "\n" + schemaFragments,
);
writeFileSync(SCHEMA, schema);
written.add("prisma/schema.prisma");

// --- merge plugin npm dependencies, then refresh the lock ---
// The Dockerfile runs `npm ci`, which fails hard when package.json and
// package-lock.json disagree — so writing deps without refreshing the lock would
// produce a composed image that cannot build. Both files are tracked, so the
// skip-worktree + `git checkout` machinery below hides and reverses them already.
if (pluginDeps.length > 0) {
  const PKG = join(ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  const merged = mergeDependencies(pkg.dependencies ?? {}, pluginDeps);
  if (JSON.stringify(merged) !== JSON.stringify(pkg.dependencies)) {
    pkg.dependencies = merged;
    writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
    written.add("package.json");
    console.log("[plugin-sync] merged plugin dependencies — refreshing package-lock.json");
    execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    written.add("package-lock.json");
  }
}

// --- generate the registration composition files ---
const idx =
  manifests.map((m) => `import { ${camelSlug(m.slug)}Manifest } from "${m.importPath}";`).join("\n") +
  `\nimport { PluginRegistry } from "../registry";\n\n// GENERATED by scripts/plugins/sync.mjs — do not edit; not committed.\n` +
  manifests.map((m) => `PluginRegistry.register(${camelSlug(m.slug)}Manifest);`).join("\n") + "\nexport {};\n";
writeFileSync(join(ROOT, REG_INDEX), idx);
written.add(REG_INDEX);

const srv =
  `import "./index";\nimport { PluginServerRegistry } from "../registry";\nimport { IntegrationRegistry } from "@/lib/integrations/registry";\n` +
  manifests.map((m) => `import { ${camelSlug(m.slug)}ServerHooks } from "${m.serverPath}";`).join("\n") +
  `\n\n// GENERATED by scripts/plugins/sync.mjs — do not edit; not committed.\n` +
  manifests.map((m) => `PluginServerRegistry.register(${camelSlug(m.slug)}ServerHooks);\nfor (const p of ${camelSlug(m.slug)}ServerHooks.integrations ?? []) IntegrationRegistry.register(p);`).join("\n") +
  "\nexport {};\n";
writeFileSync(join(ROOT, REG_SERVER), srv);
written.add(REG_SERVER);

// --- keep every composed path OUT of a core commit ---
// Untracked overlaid files: .git/info/exclude. Tracked core files we modified in
// place (schema + the two registries): skip-worktree, so their composed content is
// never staged/committed (exclude has no effect on tracked files).
const trackedWritten = [...written].filter((w) => trackedSet.has(w));
if (trackedWritten.length) git(["update-index", "--skip-worktree", ...trackedWritten]);
// State file: the REAL paths, for --clean. Exclude: escaped+anchored globs, for git.
writeFileSync(STATE, [...written].sort().join("\n") + "\n");
const block = [MARK, ...[...written].sort().map(excludeEntry)].join("\n") + "\n";
appendFileSync(EXCLUDE, (existsSync(EXCLUDE) && readFileSync(EXCLUDE, "utf8").endsWith("\n") ? "" : "\n") + block);
console.log(`[plugin-sync] composed ${slugs.length} plugin(s): ${slugs.join(", ")} — ${written.size} path(s) written + excluded`);
console.log(`[plugin-sync] run \`npx prisma generate\` next, then build.`);
