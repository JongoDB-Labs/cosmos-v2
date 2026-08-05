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
 * @param {{prune?: boolean, onKept?: (slug: string) => void}} [opts]
 *        prune  — drop entries with no checkout (an explicit removal)
 *        onKept — called for each pin carried over untouched, so the caller can
 *                 report it rather than leaving the author to notice
 * @returns {Record<string,{ref:string}>} the next `plugins` map, slug-sorted
 */
export function mergeLock(heads, locked, opts = {}) {
  const { prune = false, onKept } = opts;
  const next = {};

  for (const [slug, sha] of Object.entries(heads)) {
    next[slug] = { ref: sha };
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
