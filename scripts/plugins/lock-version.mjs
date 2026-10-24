/**
 * The release tag recorded beside each plugin pin.
 *
 * A pin is a SHA because that is what makes a build reproducible, and it stays
 * one. A SHA says nothing to a reader, though: "foreman aec88413" does not say
 * which release that is. Each plugin's merge commit is tagged `vX.Y.Z` from its
 * plugin.json version, so the lock records that tag as `"version"` too — and
 * the tag is only worth recording if it names the SAME commit as the ref.
 *
 * A tag can be moved or re-created; a SHA cannot. So the ref stays the truth and
 * the version is checked against it, never the other way round.
 *
 * Split out of lock.mjs so the rule can be tested without a filesystem, the same
 * shape as lock-merge.mjs and lock-direction.mjs.
 */

/** A release tag as the plugin repos cut them. */
export const VERSION_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

/** The tag a plugin.json version is released under, or null if it is not SemVer. */
export function versionTag(manifestVersion) {
  const tag = `v${manifestVersion ?? ""}`;
  return VERSION_RE.test(tag) ? tag : null;
}

/**
 * Every recorded `"version"` that does not describe its pin.
 *
 * @param {Record<string,{ref:string, version?:string}>} plugins  the lock's `plugins` map
 * @param {(slug: string, tag: string) => string | null | undefined} resolveTag
 *        the commit `tag` names in that plugin's checkout: null when the checkout
 *        has no such tag, undefined when there is no checkout to ask (the normal
 *        state for most plugins on most machines, so it is not a problem)
 * @returns {{slug: string, message: string}[]}
 */
export function judgeLockVersions(plugins, resolveTag) {
  const problems = [];
  for (const [slug, entry] of Object.entries(plugins)) {
    const { ref, version } = entry ?? {};
    if (version === undefined) continue;
    if (typeof version !== "string" || !VERSION_RE.test(version)) {
      problems.push({ slug, message: `${slug}: version "${version}" is not a vX.Y.Z tag` });
      continue;
    }
    // A tag names one commit; `main` is a moving head. Recording both claims a
    // release the build will not necessarily compose.
    if (ref === "main") {
      problems.push({ slug, message: `${slug}: version ${version} recorded against a 'main' pin` });
      continue;
    }
    const sha = resolveTag(slug, version);
    if (sha === undefined) continue;
    if (sha === null) {
      problems.push({
        slug,
        message: `${slug}: tag ${version} not found in plugins/${slug} (git -C plugins/${slug} fetch --tags)`,
      });
    } else if (sha !== ref) {
      problems.push({
        slug,
        message: `${slug}: tag ${version} is ${sha.slice(0, 9)}, but the pin is ${ref.slice(0, 9)}`,
      });
    }
  }
  return problems;
}
