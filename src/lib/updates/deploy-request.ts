/**
 * Recording an operator's intent to deploy — and refusing when it is not safe.
 *
 * THE BOUNDARY THIS EXISTS TO RESPECT. The app cannot deploy itself. Its
 * container has no docker socket and no host mount (verified on production: the
 * only mount is the MinIO CA volume). So this module records an INTENT, and a
 * host-side runner is what actually invokes `.deploy/deploy-migrate.sh`.
 *
 * The deploy script is the entire safety story — it derives repos from compose
 * service names, requires app and migrate at the SAME tag, takes a pre-deploy
 * `pg_dump` and aborts without one, migrates while the old app still serves,
 * health-gates internally and through the public hostname, and restores the
 * override on failure. Nothing here re-expresses any of that. A second
 * implementation of the deploy sequence is how the UI and the host come to
 * disagree about what "deployed" means.
 *
 * SINGLE-FLIGHT IS THE DATABASE'S JOB, NOT THIS FILE'S. Two concurrent runs
 * against one host is the failure mode. A check-then-insert here cannot prevent
 * it — two requests can both read "none active" before either writes. The
 * migration carries a partial unique index permitting at most one row in
 * PENDING or RUNNING, so the loser of any race gets a unique violation. This
 * module's job is to turn that into an honest 409, not to pre-empt it.
 */
import type { UpdateCheck } from "./check";

/** Postgres unique-violation code, surfaced by Prisma as `code`. */
export const UNIQUE_VIOLATION = "P2002";

export type DeployRefusal =
  | { ok: false; reason: "not-configured"; detail: string }
  | { ok: false; reason: "check-failed"; detail: string }
  | { ok: false; reason: "no-update"; detail: string }
  | { ok: false; reason: "version-mismatch"; detail: string }
  | { ok: false; reason: "preflight-blocked"; detail: string };

export type DeployDecision = { ok: true; version: string } | DeployRefusal;

/**
 * Whether a deploy of `requestedVersion` may be recorded, judged against a FRESH
 * update check.
 *
 * The check is re-run server-side rather than trusting what the page displayed.
 * A screen can be minutes old; images can be deleted, a registry can go down,
 * and an operator can leave a tab open overnight. Deciding from the payload the
 * browser happened to be holding is how you deploy a version whose images no
 * longer exist.
 *
 * `requestedVersion` must match what the check found. It is not used to pick a
 * version — the check does that — it is there so a stale tab CANNOT silently
 * deploy something other than what the operator read on screen.
 */
export function decideDeploy(requestedVersion: string, check: UpdateCheck): DeployDecision {
  if (!check.configured) {
    return { ok: false, reason: "not-configured", detail: "Update checking is not configured on this instance." };
  }
  if (check.error) {
    // An unreadable registry is UNKNOWN, never "go ahead".
    return { ok: false, reason: "check-failed", detail: `The registry could not be read: ${check.error}` };
  }
  if (!check.status?.updateAvailable || !check.status.latest) {
    return { ok: false, reason: "no-update", detail: "There is no newer version to deploy." };
  }
  if (requestedVersion !== check.status.latest) {
    return {
      ok: false,
      reason: "version-mismatch",
      detail: `You asked to deploy ${requestedVersion}, but the newest available version is now ${check.status.latest}. Re-check before deploying.`,
    };
  }

  // The preflights ARE the gate — including the sidecar pairing, which is
  // exactly "all four images exist at the same tag". `applyable` already
  // encodes "no blocking check failed or went unanswered".
  const blocking = check.preflights.filter((p) => p.blocking && p.status !== "pass");
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: "preflight-blocked",
      detail: `Blocked by ${blocking.length} check(s): ${blocking.map((b) => b.title).join("; ")}.`,
    };
  }

  return { ok: true, version: check.status.latest };
}

/** HTTP status for a refusal — distinct codes so the UI can react precisely. */
export function refusalStatus(reason: DeployRefusal["reason"]): number {
  switch (reason) {
    case "not-configured":
      return 501; // the capability is not set up on this instance
    case "check-failed":
      return 503; // upstream (the registry) could not be consulted
    case "version-mismatch":
      return 409; // what you saw is no longer true
    case "no-update":
    case "preflight-blocked":
      return 422; // understood, and refused on the merits
  }
}
