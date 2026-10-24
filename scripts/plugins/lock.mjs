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
 * Each pin also records its release tag as `"version"` when the plugin's HEAD is
 * the commit its plugin.json version is tagged at (`vX.Y.Z`, cut by the GitLab
 * release flow). The ref stays the truth; a recorded version that does not
 * resolve to it fails the check — see lock-version.mjs.
 *
 * Only PUBLIC_PLUGINS (lock-merge.mjs) are ever written: this file ships in the
 * public core, and a private plugin checked out under plugins/ is ignored.
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
import { mergeLock, publicOnly, PUBLIC_PLUGINS } from "./lock-merge.mjs";
import { judgeLockMoves } from "./lock-direction.mjs";
import { judgeLockVersions, versionTag } from "./lock-version.mjs";

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

/** The commit `tag` names in the checkout at `dir`, or null if it has no such tag. */
function tagCommit(dir, tag) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The release tag of `sha` in the checkout at `dir`: its plugin.json version as
 *  `vX.Y.Z`, but only if that tag exists and names `sha`. */
function releaseTagOf(dir, sha) {
  let manifest;
  try {
    manifest = JSON.parse(
      execFileSync("git", ["-C", dir, "show", `${sha}:plugin.json`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
  const tag = versionTag(manifest?.version);
  return tag && tagCommit(dir, tag) === sha ? tag : null;
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
  // Never even look at a private plugin: see PUBLIC_PLUGINS.
  if (!PUBLIC_PLUGINS.includes(slug)) {
    console.log(`[plugin-lock] ${slug}: not a public plugin — never locked`);
    continue;
  }
  // A plugin is only lockable if it is its own checkout — the composed tree has
  // no separate history to pin. headOf() enforces that.
  const sha = headOf(join(PLUGINS_DIR, slug));
  if (sha) current[slug] = sha;
}

const locked = readJson(LOCK)?.plugins ?? {};

/** For judgeLockVersions: undefined when the plugin has no checkout to ask. */
const resolveTag = (slug, tag) =>
  slug in current ? tagCommit(join(PLUGINS_DIR, slug), tag) : undefined;

if (write) {
  // A plugin with no checkout keeps its pin — see lock-merge.mjs. Each plugin is
  // its own private repo, so "not cloned here" is the normal state, not a signal
  // that a release stopped composing with it.
  const kept = [];
  const versions = {};
  for (const [slug, sha] of Object.entries(current)) {
    const tag = releaseTagOf(join(PLUGINS_DIR, slug), sha);
    if (tag) versions[slug] = tag;
    else console.warn(`[plugin-lock] ${slug}: ${sha.slice(0, 9)} is not a tagged release — pinned with no version`);
  }
  // publicOnly over the RESULT, so a private slug already in the file (written
  // before the allowlist existed) is dropped too rather than kept forever.
  const plugins = publicOnly(mergeLock(current, locked, { prune, versions, onKept: (slug) => kept.push(slug) }));

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

  // A KEPT entry's version was never re-derived here, so judge the whole map.
  const versionProblems = judgeLockVersions(plugins, resolveTag);
  if (versionProblems.length > 0) {
    for (const p of versionProblems) console.error(`[plugin-lock] ${p.message}`);
    console.error(`[plugin-lock] plugins.lock.json NOT written.`);
    process.exit(1);
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
    const tag = plugins[v.slug]?.version;
    console.log(`[plugin-lock] ${v.message}${tag ? ` (${tag})` : ""}`);
  }
  // Say what was carried over rather than leaving it to be noticed in the diff:
  // silence here is what made the old behaviour dangerous.
  for (const slug of kept.filter((s) => s in plugins)) {
    console.log(`[plugin-lock] ${slug}: kept ${locked[slug].ref.slice(0, 9)} — no checkout under plugins/`);
  }
  const dropped = Object.keys(locked).filter((s) => !(s in plugins));
  for (const slug of dropped) {
    console.log(`[plugin-lock] ${slug}: DROPPED (${PUBLIC_PLUGINS.includes(slug) ? "--prune" : "not a public plugin"})`);
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
for (const slug of Object.keys(locked)) {
  if (!PUBLIC_PLUGINS.includes(slug)) {
    console.error(`[plugin-lock] ${slug}: not a public plugin — it must not appear in plugins.lock.json`);
    bad++;
  }
}
for (const p of judgeLockVersions(locked, resolveTag)) {
  console.error(`[plugin-lock] ${p.message}`);
  bad++;
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
