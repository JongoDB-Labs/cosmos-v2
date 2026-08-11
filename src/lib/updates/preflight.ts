/**
 * Preflight checks: the gate that makes an upgrade offer defensible.
 *
 * The commercial pattern (Replicated/KOTS and friends) runs preflights BEFORE
 * offering an update, and that ordering is the point — an unconditional
 * one-click upgrade is Watchtower, which is popular and widely considered
 * unsafe in production precisely because it actuates without a gate.
 *
 * WHAT THIS MODULE IS. Pure evaluation over facts someone else gathered. It
 * performs no I/O deliberately, because the facts come from two different places
 * with different reach:
 *
 *   - the APP can see the registry, its own database, its own health and its
 *     own configuration;
 *   - only the HOST-side actuator can see disk space, the docker daemon, and
 *     whether a backup would fit.
 *
 * The app container has no docker socket and no host mount, so it genuinely
 * cannot answer the host questions. Splitting evaluation from gathering lets the
 * same predicates run in both places and lets the app be honest about the gap
 * rather than quietly scoring an unobservable check as fine.
 *
 * THE CENTRAL RULE: `unknown` is not `pass`. A check that could not be performed
 * blocks a blocking check. Treating "I could not look" as "it is fine" is how a
 * gate becomes decoration — the same failure that let a deploy gate point at a
 * registry nobody deployed from and report health for a year.
 */

export type PreflightStatus = "pass" | "warn" | "fail" | "unknown";

export interface PreflightResult {
  id: string;
  title: string;
  status: PreflightStatus;
  /** One sentence an operator can act on. Never contains credentials. */
  detail: string;
  /**
   * Whether this check gates the upgrade. A non-blocking check that fails is
   * information; a blocking check that fails — or that could not be run — stops
   * the offer.
   */
  blocking: boolean;
}

export interface PreflightFacts {
  currentVersion: string;
  candidateVersion: string | null;
  /** True when the instance is newer than anything the registry offers. */
  ahead: boolean;
  /** Digest the candidate tag resolves to, or null when it did not resolve. */
  candidateDigest: string | null;
  /** Whether BOTH the app and its migrate image resolved at the same tag. */
  migrateImagePresent: boolean | null;
  /** Registry host the candidate came from, for the expected-source check. */
  candidateRegistryHost: string | null;
  /** Registry host configured for this deployment. */
  expectedRegistryHost: string | null;
  /** Database reachable right now. */
  dbReachable: boolean | null;
  /** Health of the running instance before we touch anything. */
  currentHealthOk: boolean | null;
  /** Free bytes where images and the pre-upgrade dump land. null ⇒ not observable here. */
  hostDiskFreeBytes: number | null;
  /** Bytes the upgrade is expected to need. null ⇒ unknown. */
  estimatedRequiredBytes: number | null;
}

const ok = (v: boolean | null): PreflightStatus => (v === null ? "unknown" : v ? "pass" : "fail");

export function evaluatePreflights(f: PreflightFacts): PreflightResult[] {
  const results: PreflightResult[] = [];

  results.push({
    id: "candidate-resolves",
    title: "Candidate image exists",
    status: f.candidateVersion === null ? "unknown" : f.candidateDigest ? "pass" : "fail",
    detail: f.candidateDigest
      ? `${f.candidateVersion} resolves to ${f.candidateDigest.slice(0, 19)}…`
      : f.candidateVersion === null
        ? "No candidate version was selected."
        : `${f.candidateVersion} did not resolve to a digest in the registry.`,
    blocking: true,
  });

  results.push({
    id: "migrate-image-paired",
    title: "Matching migration image",
    status: ok(f.migrateImagePresent),
    detail:
      f.migrateImagePresent === null
        ? "Could not check whether the migration image exists at the same tag."
        : f.migrateImagePresent
          ? "The app and migration images resolve at the same tag."
          : "The migration image is missing at this tag. Deploying the app alone would run new code against an unmigrated schema.",
    blocking: true,
  });

  // An image from an unexpected host is the shape of a supply-chain substitution,
  // and also of a plain misconfiguration. Both are worth stopping for.
  const hostMatches =
    f.candidateRegistryHost === null || f.expectedRegistryHost === null
      ? null
      : f.candidateRegistryHost === f.expectedRegistryHost;
  results.push({
    id: "expected-registry",
    title: "Image comes from the configured registry",
    status: ok(hostMatches),
    detail:
      hostMatches === null
        ? "Could not determine the registry this candidate came from."
        : hostMatches
          ? `Candidate is from ${f.candidateRegistryHost}, as configured.`
          : `Candidate is from ${f.candidateRegistryHost}, but this deployment is configured for ${f.expectedRegistryHost}.`,
    blocking: true,
  });

  results.push({
    id: "not-a-downgrade",
    title: "Upgrade moves forward",
    status: f.ahead ? "fail" : "pass",
    detail: f.ahead
      ? `This instance runs ${f.currentVersion}, which is newer than anything the registry offers. Applying the newest tag would be a DOWNGRADE, and downgrading across a schema migration corrupts data.`
      : "The candidate is newer than the running version.",
    blocking: true,
  });

  results.push({
    id: "db-reachable",
    title: "Database reachable",
    status: ok(f.dbReachable),
    detail:
      f.dbReachable === null
        ? "Could not reach the database to check."
        : f.dbReachable
          ? "The database is responding."
          : "The database is not responding. An upgrade runs migrations and would fail partway.",
    blocking: true,
  });

  // Upgrading off a broken baseline is not forbidden, but it destroys your
  // ability to read the result: if health is red afterwards you cannot tell
  // whether the upgrade did it, and the rollback restores a broken state too.
  results.push({
    id: "healthy-baseline",
    title: "Instance is healthy before upgrading",
    status: f.currentHealthOk === null ? "unknown" : f.currentHealthOk ? "pass" : "warn",
    detail:
      f.currentHealthOk === null
        ? "Could not read current health."
        : f.currentHealthOk
          ? "The running instance reports healthy."
          : "The instance is already unhealthy. Upgrading now makes the result unreadable — a red afterwards will not tell you whether the upgrade caused it.",
    blocking: false,
  });

  const diskKnown = f.hostDiskFreeBytes !== null && f.estimatedRequiredBytes !== null;
  results.push({
    id: "disk-headroom",
    title: "Disk headroom for the image and backup",
    status: !diskKnown
      ? "unknown"
      : f.hostDiskFreeBytes! >= f.estimatedRequiredBytes!
        ? "pass"
        : "fail",
    detail: !diskKnown
      ? "Not observable from the application container — it has no host mount. The host-side actuator must check this before pulling."
      : f.hostDiskFreeBytes! >= f.estimatedRequiredBytes!
        ? "Enough free space for the image and the pre-upgrade database dump."
        : "Not enough free space. The pre-upgrade dump IS the rollback, so a full disk loses the rollback before it is needed.",
    blocking: true,
  });

  return results;
}

/**
 * Whether an upgrade may be offered as applyable.
 *
 * `unknown` on a blocking check counts against, not for. The app cannot observe
 * disk from inside a container, so a check run purely in-app will legitimately
 * report `false` here — that is the honest answer, and the reason actuation
 * belongs to the host-side runner that CAN see the missing facts.
 */
export function canApply(results: readonly PreflightResult[]): boolean {
  return !results.some((r) => r.blocking && r.status !== "pass");
}

/** Blocking checks that did not pass, for an operator-facing explanation. */
export function blockers(results: readonly PreflightResult[]): PreflightResult[] {
  return results.filter((r) => r.blocking && r.status !== "pass");
}
