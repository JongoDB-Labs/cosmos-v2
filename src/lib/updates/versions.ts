/**
 * Deciding whether a newer release exists — the pure half, with no I/O.
 *
 * WHAT THIS INSTANCE CAN AND CANNOT KNOW. The app runs *inside* the image being
 * compared. Its container has no docker socket and no compose-file mount (only a
 * MinIO CA volume), so it cannot read its own image reference, its own digest, or
 * the registry it was pulled from. It knows exactly one thing about its own
 * deployment: its VERSION. Everything else has to be configured or fetched.
 *
 * That is why the comparison here is version-based rather than digest-based. A
 * digest comparison would be stronger — a rebuilt tag changes digest while the
 * version string stays put — but it is not available to us: we have nothing
 * trustworthy to compare a remote digest *against*. Digests are still carried
 * through for display and verification, never as the "am I current" signal.
 *
 * Ordering delegates to `compareVersions` from the changelog module rather than
 * reimplementing SemVer, so "newer" means exactly what the What's-new modal
 * already means by it.
 */
import { compareVersions } from "@/lib/changelog";

/** A plain `MAJOR.MINOR.PATCH`. Registry tags carry other things — `latest`,
 *  branch names, digests-as-tags — and those are not releases. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function isVersion(s: string): boolean {
  return VERSION_RE.test(s);
}

/**
 * The release versions hiding in a registry tag list.
 *
 * Composed instances tag `<version>-<suffix>` (`2.276.8-alpha`); the neutral
 * core tags bare `<version>`. Passing a suffix accepts BOTH shapes and returns
 * the bare version either way, because the version is what gets compared and
 * displayed — the suffix is a packaging detail of the tag.
 *
 * Anything unparseable is dropped rather than throwing: a registry may hold any
 * tag at all, and one odd entry must not blank the whole update check.
 *
 * Returns ascending, deduplicated.
 */
export function versionsFromTags(tags: readonly string[], suffix = ""): string[] {
  const out = new Set<string>();
  for (const tag of tags) {
    const t = tag.trim();
    if (!t) continue;
    if (isVersion(t)) {
      out.add(t);
      continue;
    }
    if (suffix && t.endsWith(`-${suffix}`)) {
      const bare = t.slice(0, -(suffix.length + 1));
      if (isVersion(bare)) out.add(bare);
    }
  }
  return [...out].sort(compareVersions);
}

export interface UpdateStatus {
  /** The version this instance is running. */
  current: string;
  /** Newest release the registry offers, or null when it offers none we parsed. */
  latest: string | null;
  /** Releases strictly newer than `current`, ascending. */
  newer: string[];
  updateAvailable: boolean;
  /**
   * True when the running version is NEWER than anything the registry lists.
   *
   * Not a hypothetical: it is the normal state during a rollout, and the state
   * a stale/misconfigured registry produces. Callers must never present this as
   * an update — offering the "newest" tag here is a DOWNGRADE, and downgrading
   * across a schema migration is how you corrupt a database. Foreman's
   * reconciler refuses the same case explicitly.
   */
  ahead: boolean;
}

export function updateStatus(current: string, available: readonly string[]): UpdateStatus {
  const versions = [...available].filter(isVersion).sort(compareVersions);
  const latest = versions.length > 0 ? versions[versions.length - 1] : null;

  if (!isVersion(current)) {
    // An unreadable running version means we cannot compare. Report NOTHING
    // available rather than guessing — "refusing to decide blind" beats
    // offering an upgrade whose direction we cannot establish.
    return { current, latest, newer: [], updateAvailable: false, ahead: false };
  }

  const newer = versions.filter((v) => compareVersions(v, current) > 0);
  return {
    current,
    latest,
    newer,
    updateAvailable: newer.length > 0,
    ahead: latest !== null && compareVersions(current, latest) > 0,
  };
}
