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
 *
 * Overwrite guard: composed copies are git-invisible (exclude/skip-worktree), so
 * git offers NO safety net for edits mistakenly made to them — a re-compose or
 * `--clean` would silently discard the only copy. Every compose records a content
 * hash per written file; any later run refuses (loudly, listing the files) when a
 * composed copy has been edited since. `--force` discards the edits on purpose.
 *
 * `--watch` (or `npm run sync:watch`): after composing, watch each plugin's
 * overlay/ and re-copy changed files into the composed tree immediately, so the
 * CORRECT place to edit (the plugin repo) is also the one the dev server
 * hot-reloads from. Structural changes (added/removed files, plugin.json, the
 * schema fragment, migrations) trigger a full re-compose.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, copyFileSync, rmSync, rmdirSync, appendFileSync, watch as fsWatch } from "node:fs";
import { join, dirname, relative } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mergeDependencies } from "./merge-deps.mjs";
import { renderRegistryIndex, renderRegistryServer } from "./render-registry.mjs";

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
const HASHES = join(gitPath("--git-dir"), "plugin-sync.hashes"); // "<sha1> <path>" per composed file (overwrite guard)
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
const REG_INDEX = "src/lib/plugins/registry/index.ts";
const REG_SERVER = "src/lib/plugins/registry/server.ts";
const MARK = "# --- plugin-sync managed (do not commit) ---";
/** Escape gitignore metacharacters + anchor to root: exclude entries are matched as
 *  globs, so a literal path like `.../[orgId]/...` needs its []*? escaped. */
const excludeEntry = (p) => "/" + p.replace(/([[\]*?])/g, "\\$1");

const clean = process.argv.includes("--clean");
const force = process.argv.includes("--force");
const watchMode = process.argv.includes("--watch");

const fileHash = (abs) => createHash("sha1").update(readFileSync(abs)).digest("hex");

const readHashes = () =>
  !existsSync(HASHES)
    ? {}
    : Object.fromEntries(
        readFileSync(HASHES, "utf8").split("\n").filter(Boolean).map((l) => {
          const i = l.indexOf(" ");
          return [l.slice(i + 1), l.slice(0, i)];
        }),
      );

const writeHashes = (map) =>
  writeFileSync(HASHES, Object.entries(map).map(([rel, h]) => `${h} ${rel}`).sort().join("\n") + "\n");

/**
 * The overwrite guard. Composed copies are hidden from git (exclude /
 * skip-worktree), so an edit mistakenly made to one exists NOWHERE else — and
 * both `--clean` and the fresh-compose restore would silently destroy it.
 * Compare every managed file against the hash recorded at compose time and
 * refuse before touching anything. Runs BEFORE removeManagedExclude(), which
 * deletes the state this check needs.
 */
function guardDirtyComposed() {
  if (force || !existsSync(STATE)) return;
  const recorded = readHashes();
  const dirty = [];
  for (const rel of readFileSync(STATE, "utf8").split("\n").filter(Boolean)) {
    const abs = join(ROOT, rel);
    if (recorded[rel] && existsSync(abs) && fileHash(abs) !== recorded[rel]) dirty.push(rel);
  }
  if (dirty.length) {
    console.error(`[plugin-sync] REFUSING to overwrite ${dirty.length} composed file(s) edited since the last compose:`);
    for (const rel of dirty) console.error(`  ${rel}`);
    console.error("[plugin-sync] Composed copies are git-invisible — these edits exist nowhere else.");
    console.error("[plugin-sync] Move them into the owning plugin (edit plugins/<slug>/overlay/** — the same");
    console.error("[plugin-sync] path under overlay/), then re-run. Or pass --force to DISCARD them.");
    process.exit(1);
  }
}

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
  rmSync(HASHES, { force: true });
  return managed;
}

function restore() {
  guardDirtyComposed();
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
const watchTargets = [];         // { slug, overlayRoot, structural[] } for --watch

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
  // 5) migrations — the plugin OWNS its schema, so it owns the DDL that creates it.
  // Composing the models without their tables would leave an image whose schema
  // references relations the database has never heard of. Directory names are the
  // plugin author's (generated once via gen-migration.mjs), so they are stable:
  // `migrate deploy` applies each exactly once and re-composing is a no-op.
  const migRoot = join(dir, cfg.migrations ?? "migrations");
  if (existsSync(migRoot)) {
    for (const abs of walk(migRoot)) {
      const rel = join("prisma", "migrations", relative(migRoot, abs));
      if (trackedSet.has(rel)) throw new Error(`[plugin-sync] ${slug}: migration collides with a tracked core migration: ${rel}`);
      const dest = join(ROOT, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
      written.add(rel);
    }
  }
  // 6) registration
  const importPath = "@/" + (cfg.manifest ?? `src/plugins/${slug}/manifest.ts`).replace(/^src\//, "").replace(/\.ts$/, "");
  const serverPath = "@/" + (cfg.serverHooks ?? `src/plugins/${slug}/server.ts`).replace(/^src\//, "").replace(/\.ts$/, "");
  // plugin.json's version is AUTHORITATIVE. The manifest also declares one, and
  // core compares THAT against the org's stored enabledVersion to decide whether
  // to run onUpgrade — so when the two drift, releases stop reaching orgs and the
  // Plugins screen reports a stale number. Nothing errors: the equality check
  // short-circuits and returns, which is right when they match and silent when
  // they only appear to. One plugin sat eight releases behind that way.
  //
  // Stamping it here makes the drift impossible rather than detectable, for every
  // plugin composed now or later, with no per-plugin discipline required.
  if (!cfg.version) {
    // Not fatal — a plugin without a declared version simply keeps whatever its
    // manifest hardcodes, which is the behaviour that existed before. But it is
    // the exact shape that let one plugin drift eight releases, so say so.
    console.warn(
      `[plugin-sync] ${slug}: plugin.json has no "version". Its manifest's own ` +
        `version is then the only source, and a stale one silently stops onUpgrade ` +
        `firing for every org. Add "version" to plugin.json.`,
    );
  }
  manifests.push({ slug, importPath, serverPath, version: cfg.version ?? null });
  // 7) --watch bookkeeping: overlay edits hot-copy; these paths force a re-compose.
  watchTargets.push({
    slug,
    overlayRoot,
    structural: [join(dir, "plugin.json"), frag, migRoot].filter(existsSync),
  });
}

// --- write schema (inject fragments + back-relations at the markers) ---
let schema = readFileSync(SCHEMA, "utf8");
for (const [model, lines] of Object.entries(backrel)) {
  const marker = `  // @plugin-backrel:${model}`;
  if (!schema.includes(marker)) throw new Error(`[plugin-sync] missing schema marker: ${marker}`);
  schema = schema.replace(marker, marker + "\n" + lines.join("\n"));
}
// Matched on the marker PREFIX, and it throws when absent — the back-relation
// markers above already do. A plain String.replace on the full sentence fails
// SILENTLY if anyone rewords or trims that comment: every plugin's models
// quietly stop being composed, the schema still parses, and the first sign is
// Prisma reporting unknown models at runtime.
const FRAGMENT_MARKER = "// @plugin-schema-fragments";
if (!schema.includes(FRAGMENT_MARKER)) {
  throw new Error(`[plugin-sync] missing schema marker: ${FRAGMENT_MARKER}`);
}
schema = schema.replace(
  new RegExp(`^${FRAGMENT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`, "m"),
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
    // --ignore-scripts is REQUIRED, not tidiness. `--package-lock-only` still
    // runs the `prepare` lifecycle script, and this repo's prepare runs husky —
    // which is a devDependency that is not installed at compose time on a clean
    // runner. npm then exits 127 ("sh -c husky": command not found) and takes
    // the whole release build with it. It works on a developer machine purely
    // because husky is already in node_modules there.
    //
    // Skipping scripts is also correct on the merits: this resolves a dependency
    // graph to refresh the lockfile, it does not build or install anything.
    //
    // `shell: true` matches how a workflow `run:` step resolves `npm`.
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
    });
    written.add("package-lock.json");
  }
}

// --- generate the registration composition files ---
// Rendering lives in render-registry.mjs so its slug→identifier handling can be
// asserted directly (render-registry.test.mjs) — a kebab-case slug interpolated
// raw emits invalid JS and fails the whole composed build.
writeFileSync(join(ROOT, REG_INDEX), renderRegistryIndex(manifests));
written.add(REG_INDEX);

writeFileSync(join(ROOT, REG_SERVER), renderRegistryServer(manifests));
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
// Record what we wrote — the overwrite guard's baseline for the NEXT run.
const hashes = {};
for (const rel of written) hashes[rel] = fileHash(join(ROOT, rel));
writeHashes(hashes);

console.log(`[plugin-sync] composed ${slugs.length} plugin(s): ${slugs.join(", ")} — ${written.size} path(s) written + excluded`);
console.log(`[plugin-sync] run \`npx prisma generate\` next, then build.`);

// ─── --watch: keep the composed tree in lockstep with overlay edits ──────────
// The failure mode this kills: the dev server hot-reloads the COMPOSED copies,
// so the tempting place to edit is the wrong (git-invisible) one. With the
// watcher running, editing the RIGHT place — plugins/<slug>/overlay/** — lands
// in the composed tree within a debounce tick, so correct and convenient are
// the same path. Content edits hot-copy; structural changes re-compose fully.
if (watchMode) {
  const overlayRel = new Map(); // composed rel -> { srcAbs } for fast hot-copy
  for (const t of watchTargets) {
    for (const abs of walk(t.overlayRoot)) overlayRel.set(relative(t.overlayRoot, abs), abs);
  }

  let timer = null;
  const pendingCopies = new Map(); // overlay abs -> composed rel
  let needRecompose = false;

  const flush = () => {
    timer = null;
    if (needRecompose) {
      needRecompose = false;
      pendingCopies.clear();
      console.log("[plugin-sync] structural change — re-composing…");
      // Re-run ourselves WITHOUT --watch: the guard passes because incremental
      // copies keep the hash baseline current. Watchers stay armed on the same
      // overlay dirs, so the loop survives the re-compose.
      const r = spawnSync(process.execPath, [process.argv[1]], { cwd: ROOT, stdio: "inherit" });
      if (r.status !== 0) { console.error("[plugin-sync] re-compose FAILED — fix the error and save again"); return; }
      // Adopt the child's world: fresh hash baseline + the new composed file set,
      // so later hot-copies neither clobber the baseline nor miss added files.
      for (const k of Object.keys(hashes)) delete hashes[k];
      Object.assign(hashes, readHashes());
      overlayRel.clear();
      for (const t of watchTargets) {
        for (const abs of walk(t.overlayRoot)) overlayRel.set(relative(t.overlayRoot, abs), abs);
      }
      return;
    }
    for (const [srcAbs, rel] of pendingCopies) {
      pendingCopies.delete(srcAbs);
      try {
        copyFileSync(srcAbs, join(ROOT, rel));
        hashes[rel] = fileHash(join(ROOT, rel));
        console.log(`[plugin-sync] ↻ ${rel}`);
      } catch (e) {
        console.error(`[plugin-sync] copy failed for ${rel}: ${e.message}`);
      }
    }
    writeHashes(hashes);
  };
  const schedule = () => { if (!timer) timer = setTimeout(flush, 150); };

  for (const t of watchTargets) {
    fsWatch(t.overlayRoot, { recursive: true }, (_event, filename) => {
      if (!filename) { needRecompose = true; return schedule(); }
      const srcAbs = join(t.overlayRoot, filename);
      // Known file with content still present → hot-copy. Anything else (new
      // file, deletion, rename) changes the composed file SET → re-compose.
      if (overlayRel.has(filename) && existsSync(srcAbs) && statSync(srcAbs).isFile()) {
        pendingCopies.set(srcAbs, filename);
      } else {
        needRecompose = true;
      }
      schedule();
    });
    for (const structuralPath of t.structural) {
      fsWatch(structuralPath, { recursive: true }, () => { needRecompose = true; schedule(); });
    }
  }
  console.log(`[plugin-sync] watching overlay(s) of: ${watchTargets.map((t) => t.slug).join(", ")} — Ctrl-C to stop`);
}
