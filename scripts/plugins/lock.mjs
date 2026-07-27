/**
 * Record which plugin commit each core release composes with.
 *
 * The assembly build checks plugins out at `main` by default, so a core release
 * bundles whatever the plugin repo happened to hold when the image was built —
 * not what the release describes. Anything pushed to a plugin between a core
 * merge and its build rides along silently, under a version whose changelog says
 * nothing about it, and the same image rebuilt a week later is a different image.
 *
 * This makes the pairing explicit: the PUBLIC core states the exact plugin
 * commits it was released against, so a build is reproducible and a release
 * describes what actually ships.
 *
 * Only a commit SHA and a slug are recorded. The slugs already appear in the
 * public core (route paths, design docs); a SHA discloses nothing about a
 * private repo's contents.
 *
 * Usage:
 *   node scripts/plugins/lock.mjs           # report drift, exit 1 if any
 *   node scripts/plugins/lock.mjs --write   # record current plugin HEADs
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const LOCK = join(ROOT, "plugins.lock.json");
const PLUGINS_DIR = join(ROOT, "plugins");
const write = process.argv.includes("--write");

/** A ref the assembly build will accept: a full SHA, or `main` for a plugin
 *  deliberately tracked at head. Anything else is a ref-injection risk. */
const REF_RE = /^(main|[0-9a-f]{40})$/;

/** Read and parse a JSON file, or null if it is absent or unreadable. Reading
 *  and handling failure avoids the check-then-use race that an existsSync guard
 *  introduces (CodeQL js/file-system-race). */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Directory entries, or [] if the directory is absent. Same reasoning. */
function listDir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * The HEAD of the repo rooted AT `dir`, or null if `dir` is not itself a
 * checkout.
 *
 * The toplevel comparison is load-bearing: `git -C <dir>` walks UP to the
 * nearest enclosing repository, so a plugin directory that is merely a folder
 * inside the core tree would happily report the CORE's HEAD and silently pin
 * every plugin to the wrong commit. Checking the resolved root instead of
 * stat-ing `.git` gets the same guarantee without a check-then-use race.
 */
function headOf(dir) {
  try {
    const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (resolve(top) !== resolve(dir)) return null;
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const current = {};
for (const slug of listDir(PLUGINS_DIR).sort()) {
  // A plugin is only lockable if it is its own checkout — the composed tree has
  // no separate history to pin. headOf() enforces that.
  const sha = headOf(join(PLUGINS_DIR, slug));
  if (sha) current[slug] = sha;
}

const locked = readJson(LOCK)?.plugins ?? {};

if (write) {
  const next = {
    $comment:
      "Plugin commits this core release composes with. The assembly build reads this " +
      "so an image is reproducible and a release describes what actually ships. " +
      "Regenerate with: node scripts/plugins/lock.mjs --write",
    plugins: Object.fromEntries(
      Object.entries(current)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([slug, sha]) => [slug, { ref: sha }]),
    ),
  };
  writeFileSync(LOCK, `${JSON.stringify(next, null, 2)}\n`);
  for (const [slug, { ref }] of Object.entries(next.plugins)) {
    const was = locked[slug]?.ref;
    console.log(`[plugin-lock] ${slug}: ${was && was !== ref ? `${was.slice(0, 9)} → ` : ""}${ref.slice(0, 9)}`);
  }
  console.log(`[plugin-lock] wrote plugins.lock.json (${Object.keys(next.plugins).length} plugin(s))`);
  process.exit(0);
}

// Verify mode. Reports rather than fixes, because a mismatch during a release is
// exactly the moment someone should look rather than have it silently corrected.
let bad = 0;
for (const [slug, entry] of Object.entries(locked)) {
  if (!REF_RE.test(entry?.ref ?? "")) {
    console.error(`[plugin-lock] ${slug}: ref "${entry?.ref}" is not a full SHA or 'main'`);
    bad++;
  }
}
for (const [slug, sha] of Object.entries(current)) {
  const ref = locked[slug]?.ref;
  if (!ref) {
    console.error(`[plugin-lock] ${slug} is checked out but absent from plugins.lock.json`);
    bad++;
  } else if (ref !== "main" && ref !== sha) {
    console.error(
      `[plugin-lock] ${slug} drift: lock has ${ref.slice(0, 9)}, working copy is at ${sha.slice(0, 9)}`,
    );
    bad++;
  }
}

if (bad > 0) {
  console.error(`[plugin-lock] ${bad} problem(s). Run: node scripts/plugins/lock.mjs --write`);
  process.exit(1);
}
console.log(`[plugin-lock] ok — ${Object.keys(locked).length} plugin(s) pinned`);
