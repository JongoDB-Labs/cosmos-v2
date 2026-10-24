/**
 * The plugins this PUBLIC lockfile may name. Anything else is never written,
 * even when it is checked out under plugins/.
 *
 * The lock ships in the public core repo, so a slug in it is a disclosure. A
 * private plugin is pinned only by the private assembly; before this list, a dev
 * box that happened to hold one under plugins/ would have published its slug on
 * the next `--write`. An allowlist rather than a denylist, so every private
 * plugin is excluded by default instead of by memory.
 */
export const PUBLIC_PLUGINS = Object.freeze(["foreman", "pi-planning", "whiteboard"]);

/** `map` restricted to PUBLIC_PLUGINS. */
export function publicOnly(map) {
  return Object.fromEntries(Object.entries(map).filter(([slug]) => PUBLIC_PLUGINS.includes(slug)));
}

/**
 * Merge discovered plugin HEADs over the recorded lockfile.
 *
 * Split out of lock.mjs so the rule can be tested without a filesystem — the
 * same shape as merge-deps.mjs, and for the same reason.
 *
 * THE RULE: a plugin whose checkout is absent KEEPS its recorded pin.
 *
 * `--write` used to rebuild the file from whatever happened to be under
 * plugins/. Each plugin is a separate private repo, so a developer box normally
 * holds one of them — meaning the sanctioned way to update the lock quietly
 * unpinned every plugin the author had not cloned, and printed success. The file
 * still parsed and still validated; it just no longer described the release.
 * Absent is not the same as removed, and only one of those is something a
 * lockfile should be able to infer.
 *
 * Removing a plugin is therefore explicit: `--prune`.
 *
 * @param {Record<string,string>} heads      slug → HEAD sha, for checkouts present now
 * @param {Record<string,{ref:string}>} locked  the lockfile's current `plugins` map
 * @param {{prune?: boolean, onKept?: (slug: string) => void, versions?: Record<string,string>}} [opts]
 *        prune    — drop entries with no checkout (an explicit removal)
 *        onKept   — called for each pin carried over untouched, so the caller can
 *                   report it rather than leaving the author to notice
 *        versions — slug → release tag (`vX.Y.Z`) for checkouts whose HEAD is
 *                   tagged; a checked-out plugin without one is recorded with
 *                   no `version`, never with the stale one it had before
 * @returns {Record<string,{ref:string, version?:string}>} the next `plugins` map, slug-sorted
 */
export function mergeLock(heads, locked, opts = {}) {
  const { prune = false, onKept, versions = {} } = opts;
  const next = {};

  for (const [slug, sha] of Object.entries(heads)) {
    next[slug] = versions[slug] ? { ref: sha, version: versions[slug] } : { ref: sha };
  }

  if (!prune) {
    for (const [slug, entry] of Object.entries(locked)) {
      if (slug in next) continue;
      next[slug] = entry;
      onKept?.(slug);
    }
  }

  // Sort so the file does not churn on directory-read order, which differs
  // between machines and would otherwise show up as a spurious diff.
  return Object.fromEntries(
    Object.entries(next).sort(([a], [b]) => a.localeCompare(b)),
  );
}
