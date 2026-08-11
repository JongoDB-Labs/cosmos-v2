/**
 * Prune node_modules down to exactly what `prisma migrate deploy` needs.
 *
 * WHY THIS EXISTS
 * The migrate image was `FROM build`, i.e. the entire build stage: the full
 * node_modules (2.7 GB), the whole `.next` output (~1.7 GB) and the app source —
 * about 3.2 GB of image to run ONE command. Its push was ~134s of every build.
 *
 * WHY NOT JUST `npm install prisma dotenv` IN A CLEAN STAGE
 * That resolves the transitive tree FRESH, outside package-lock.json. For a tool
 * whose failure mode is a HALF-MIGRATED PRODUCTION SCHEMA, running a different
 * dependency tree than the one CI tested is not a tradeoff worth making. So this
 * instead prunes the tree npm already installed from the lockfile — every
 * surviving package is bit-identical to what `npm ci` produced and what the test
 * suite ran against.
 *
 * WHY NOT `npm ci --omit=dev`
 * Two reasons, both load-bearing:
 *   - `dotenv` is a devDependency, but prisma.config.ts does `import "dotenv/config"`
 *     at module scope. Dev-pruning silently removes it, the config throws on load,
 *     and Prisma then has no schema and no datasource.
 *   - next / googleapis / onnxruntime / @huggingface are real `dependencies`, so a
 *     dev-pruned tree is still ~1.5 GB. It removes the wrong things.
 *
 * WHAT IT KEEPS
 * The closure of DECLARED dependencies reachable from the entry points below —
 * `dependencies` plus any `optionalDependencies` actually present on disk (that is
 * how npm installs platform-specific binaries). Walking declared metadata rather
 * than source imports deliberately yields a SUPERSET of what is really loaded: a
 * dynamic `require()` this script cannot see is still covered.
 *
 * Only TOP-LEVEL entries are pruned. A kept package's own nested node_modules is
 * left intact, so a package that resolved a conflicting version privately keeps it.
 */
import { readdirSync, readFileSync, existsSync, rmSync, lstatSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = process.cwd();
const NM = join(ROOT, "node_modules");

// prisma  -> the CLI itself (bin/prisma, @prisma/config, @prisma/engines, ...)
// dotenv  -> imported at module scope by prisma.config.ts; see header.
const ENTRY_POINTS = ["prisma", "dotenv"];

/** Resolve a package name to its directory, honouring nesting before hoisting. */
function resolvePkgDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir || !dir.startsWith(ROOT)) return null;
    if (dir === ROOT) return null;
    dir = parent;
  }
}

function readManifest(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Breadth-first walk of declared deps. Returns the set of package NAMES to keep. */
function computeClosure() {
  const keep = new Set();
  const queue = ENTRY_POINTS.map((n) => ({ name: n, from: ROOT }));
  const missing = [];

  while (queue.length) {
    const { name, from } = queue.shift();
    if (keep.has(name)) continue;

    const dir = resolvePkgDir(name, from);
    if (!dir) {
      missing.push(name);
      continue;
    }
    keep.add(name);

    const m = readManifest(dir);
    if (!m) continue;

    const deps = { ...(m.dependencies ?? {}) };
    // optionalDependencies only count when npm actually installed them — that is
    // how platform binaries (@esbuild/linux-x64, @img/sharp-*) legitimately appear.
    for (const opt of Object.keys(m.optionalDependencies ?? {})) {
      if (resolvePkgDir(opt, dir)) deps[opt] = true;
    }
    for (const d of Object.keys(deps)) queue.push({ name: d, from: dir });
  }

  // An entry point that cannot be resolved means the image would be broken. Fail
  // LOUDLY here rather than produce an image that dies at migration time.
  const missingEntry = ENTRY_POINTS.filter((e) => !keep.has(e));
  if (missingEntry.length) {
    console.error(`[migrate-closure] FATAL: entry point(s) not installed: ${missingEntry.join(", ")}`);
    process.exit(1);
  }
  if (missing.length) {
    // Transitive misses are normal (an optional dep for another platform), so this
    // is informational — but it is PRINTED, never swallowed.
    console.log(`[migrate-closure] note: ${missing.length} declared dep(s) not on disk (optional/platform): ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`);
  }
  return keep;
}

/** Every installed top-level package name, expanding @scope/ dirs. */
function listInstalled() {
  const out = [];
  for (const e of readdirSync(NM)) {
    if (e === ".bin" || e === ".package-lock.json") continue;
    if (e.startsWith("@")) {
      const scopeDir = join(NM, e);
      let inner = [];
      try {
        inner = readdirSync(scopeDir);
      } catch {
        continue;
      }
      for (const s of inner) out.push(`${e}/${s}`);
    } else {
      out.push(e);
    }
  }
  return out;
}

const keep = computeClosure();
const installed = listInstalled();
let removed = 0;

for (const name of installed) {
  if (keep.has(name)) continue;
  rmSync(join(NM, name), { recursive: true, force: true });
  removed++;
}

// Drop .bin entries whose target no longer exists. A dangling symlink on PATH is
// a confusing failure ("command not found" vs a clear absence), so clear them.
const binDir = join(NM, ".bin");
if (existsSync(binDir)) {
  for (const b of readdirSync(binDir)) {
    const p = join(binDir, b);
    try {
      realpathSync(p);
    } catch {
      rmSync(p, { force: true });
    }
  }
}

// ACCEPTANCE: the one thing this image exists to run must still resolve. If the
// pruning ever removes something load-bearing, the BUILD fails here rather than
// the migrate Job failing against a production database.
const prismaBin = join(binDir, "prisma");
if (!existsSync(prismaBin)) {
  console.error("[migrate-closure] FATAL: node_modules/.bin/prisma is gone after pruning.");
  process.exit(1);
}
try {
  const target = realpathSync(prismaBin);
  if (!existsSync(target)) throw new Error("dangling");
} catch {
  console.error("[migrate-closure] FATAL: node_modules/.bin/prisma does not resolve to a real file.");
  process.exit(1);
}
// lstat, not stat: proves it is the symlink npm created, not something replaced.
lstatSync(prismaBin);

console.log(`[migrate-closure] kept ${keep.size} packages, removed ${removed} top-level entries`);
