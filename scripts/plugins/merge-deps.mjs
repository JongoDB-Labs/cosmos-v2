/**
 * Merge plugin-declared npm dependencies into core's `dependencies` map.
 *
 * A plugin cannot ship its own package.json — sync.mjs's overlay collision guard
 * rejects any overlay path that is a tracked core file — so
 * `plugin.json.dependencies` is the only sanctioned way for a plugin to add a
 * runtime dependency. (Before this existed, an extracted plugin's deps simply
 * stayed behind in the core package.json.)
 *
 * Version conflicts are FATAL, never silently resolved: a composed image installs
 * exactly one version of each package, so picking a winner here would build
 * something the plugin author never tested and the failure would surface at
 * runtime rather than at compose time.
 *
 * @param {Record<string,string>} coreDeps  core's `dependencies` (not mutated)
 * @param {Array<{slug: string, dependencies?: Record<string,string>}>} plugins
 * @returns {Record<string,string>} merged, key-sorted for a stable diff
 */
export function mergeDependencies(coreDeps, plugins) {
  const merged = { ...coreDeps };
  const claimedBy = new Map(); // package name -> slug that introduced it

  for (const { slug, dependencies } of plugins) {
    for (const [name, range] of Object.entries(dependencies ?? {})) {
      const existing = merged[name];
      if (existing !== undefined && existing !== range) {
        const owner = claimedBy.get(name);
        throw new Error(
          owner
            ? `[plugin-sync] dependency conflict on "${name}": ${owner} wants ${existing}, ${slug} wants ${range}`
            : `[plugin-sync] ${slug}: dependency "${name}@${range}" conflicts with core's ${existing}`,
        );
      }
      merged[name] = range;
      claimedBy.set(name, slug);
    }
  }

  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}
