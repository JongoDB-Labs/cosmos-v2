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
 *   node scripts/plugins/lock.mjs             # report drift, exit 1 if any
 *   node scripts/plugins/lock.mjs --write     # record current plugin HEADs
 *   node scripts/plugins/lock.mjs --write --prune
 *                                             # ...and DROP plugins with no checkout
 *   node scripts/plugins/lock.mjs --write --allow-rollback
 *                                             # ...and permit a pin to move BACKWARDS
 *
 * --write keeps the pin of any plugin that is not checked out locally. Each
 * plugin is a separate private repo, so holding one of them is the normal state
 * of a dev box; rebuilding the file from what happens to be present would
 * silently unpin the rest. Removing a plugin is deliberate: --prune.
 *
 * For the same reason, a stale checkout must not silently REVERT a plugin: a pin
 * may only move to a descendant of the commit it replaces — see
 * lock-direction.mjs for the two production PRs that rule exists for. Reverting
 * is deliberate too: --allow-rollback.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mergeLock } from "./lock-merge.mjs";
import { judgeLockMoves } from "./lock-direction.mjs";

const ROOT = process.cwd();
const LOCK = join(ROOT, "plugins.lock.json");
const PLUGINS_DIR = join(ROOT, "plugins");
const write = process.argv.includes("--write");
const prune = process.argv.includes("--prune");
const allowRollback = process.argv.includes("--allow-rollback");

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

/** True if `dir` holds `sha` as a commit object. A checkout fetched before that
 *  commit existed does not, which is the signal `ancestryIn` needs. */
function hasCommit(dir, sha) {
  try {
    execFileSync("git", ["-C", dir, "cat-file", "-e", `${sha}^{commit}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** True if `a` is an ancestor of `b`. `merge-base --is-ancestor` answers by exit
 *  status, so a non-zero exit — which execFileSync raises — is the "no". */
function isAncestor(dir, a, b) {
  try {
    execFileSync("git", ["-C", dir, "merge-base", "--is-ancestor", a, b], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * How `to` relates to `from` inside a plugin checkout.
 *
 * Both commits are confirmed present FIRST. Without that, a missing object
 * makes `merge-base` exit non-zero, which is indistinguishable from an honest
 * "not an ancestor" — and would report the stale-checkout case, the one this
 * guard exists for, as a clean advance.
 *
 * @returns {import("./lock-direction.mjs").Ancestry}
 */
function ancestryIn(dir, from, to) {
  if (!hasCommit(dir, from) || !hasCommit(dir, to)) return "unknown";
  if (isAncestor(dir, from, to)) return "advance";
  if (isAncestor(dir, to, from)) return "rollback";
  return "diverged";
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
  // A plugin with no checkout keeps its pin — see lock-merge.mjs. Each plugin is
  // its own private repo, so "not cloned here" is the normal state, not a signal
  // that a release stopped composing with it.
  const kept = [];
  const plugins = mergeLock(current, locked, { prune, onKept: (slug) => kept.push(slug) });

  // DIRECTION CHECK, before anything is written. Judged against `plugins` —
  // the map about to be persisted — so nothing can move a pin behind the guard's
  // back. A stale checkout is the normal state of a dev box, and the old code
  // recorded its HEAD as an advance without ever asking which way it pointed.
  const { verdicts, problems } = judgeLockMoves(plugins, locked, (slug, from, to) =>
    ancestryIn(join(PLUGINS_DIR, slug), from, to),
  );

  if (problems.length > 0 && !allowRollback) {
    for (const p of problems) console.error(`[plugin-lock] ${p.message}`);
    console.error(
      `[plugin-lock] ${problems.length} pin(s) would not move forward — plugins.lock.json NOT written.`,
    );
    process.exit(1);
  }
  for (const p of problems) {
    console.warn(`[plugin-lock] --allow-rollback: writing anyway — ${p.message}`);
  }

  const next = {
    $comment:
      "Plugin commits this core release composes with. The assembly build reads this " +
      "so an image is reproducible and a release describes what actually ships. " +
      "Regenerate with: node scripts/plugins/lock.mjs --write",
    plugins,
  };
  writeFileSync(LOCK, `${JSON.stringify(next, null, 2)}\n`);

  // The verdict carries the direction, so the log now says which way a pin moved
  // rather than leaving "a → b" to be read as progress by default.
  for (const v of verdicts) {
    if (kept.includes(v.slug)) continue;
    console.log(`[plugin-lock] ${v.message}`);
  }
  // Say what was carried over rather than leaving it to be noticed in the diff:
  // silence here is what made the old behaviour dangerous.
  for (const slug of kept) {
    console.log(`[plugin-lock] ${slug}: kept ${locked[slug].ref.slice(0, 9)} — no checkout under plugins/`);
  }
  const dropped = Object.keys(locked).filter((s) => !(s in plugins));
  for (const slug of dropped) {
    console.log(`[plugin-lock] ${slug}: DROPPED (--prune)`);
  }

  console.log(`[plugin-lock] wrote plugins.lock.json (${Object.keys(plugins).length} plugin(s))`);
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
