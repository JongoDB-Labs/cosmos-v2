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
import type { Prisma } from "@prisma/client";
import type { UpdateCheck } from "./check";
import { blockers } from "./preflight";

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
  // The version on offer: the newest one, or — when nothing newer exists but the
  // image for the running version was rebuilt — the running version itself.
  // A composed image is tagged with the CORE version, so a plugin-only release
  // is exactly that rebuild; refusing it left every such release uninstallable
  // from this page until core happened to move.
  const status = check.status;
  const target = status?.updateAvailable
    ? status.latest
    : check.rebuildAvailable === true
      ? (status?.current ?? null)
      : null;
  if (!target) {
    return { ok: false, reason: "no-update", detail: "There is no newer version or rebuilt image to deploy." };
  }
  if (requestedVersion !== target) {
    return {
      ok: false,
      reason: "version-mismatch",
      detail: status?.updateAvailable
        ? `You asked to deploy ${requestedVersion}, but the newest available version is now ${target}. Re-check before deploying.`
        : `You asked to deploy ${requestedVersion}, but what is on offer now is a rebuild of ${target}. Re-check before deploying.`,
    };
  }

  // The preflights ARE the gate — including the sidecar pairing, which is
  // exactly "all four images exist at the same tag".
  //
  // This MUST go through `blockers()` rather than re-filtering here. A deferred
  // check is not a failed one: it is a question this tier cannot answer, handed
  // to the host runner that re-evaluates it — with `deferredTo` unset, as an
  // ordinary blocking check — immediately before it acts. `disk-headroom` is
  // always deferred, because a container with no host mount can never see the
  // disk. So a local `p.blocking && p.status !== "pass"` refuses EVERY deploy on
  // EVERY host, while the page that offered the button says it is applyable.
  // One predicate, one call site: the rule lives in preflight.ts.
  const blocking = blockers(check.preflights);
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: "preflight-blocked",
      detail: `Blocked by ${blocking.length} check(s): ${blocking.map((b) => b.title).join("; ")}.`,
    };
  }

  return { ok: true, version: target };
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

/**
 * How long a RUNNING request may go without a sign of life before it is
 * declared ABANDONED.
 *
 * Generous on purpose: a pre-deploy pg_dump plus image pulls legitimately take
 * minutes, and a runner that heartbeats never gets near this. The failure it
 * exists for is a runner that died mid-deploy (on production: the app restarted
 * under it) — without it the row stays RUNNING forever, and the single-flight
 * index refuses every later install with a 409.
 */
export const DEPLOY_HEARTBEAT_STALE_MS = 30 * 60 * 1000;

type ClaimTimes = {
  status: string;
  requestedAt: Date;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
};

/**
 * Whether a request is a dead claim: RUNNING, and its last sign of life
 * (`heartbeatAt ?? claimedAt ?? requestedAt`) is older than the stale window.
 *
 * Only RUNNING. A PENDING row was never claimed — "no runner installed" is a
 * different state with its own handling, and abandoning it would hide that.
 * ABANDONED means the outcome is UNKNOWN; it is never success or failure.
 */
export function isAbandonedClaim(row: ClaimTimes, now: Date): boolean {
  if (row.status !== "RUNNING") return false;
  const lastSign = row.heartbeatAt ?? row.claimedAt ?? row.requestedAt;
  return now.getTime() - lastSign.getTime() > DEPLOY_HEARTBEAT_STALE_MS;
}

/**
 * The same rule as {@link isAbandonedClaim}, as a Prisma `where` — so the
 * reconciliation is one idempotent `updateMany`, with the coalesce spelled out
 * as OR branches over which timestamps are null.
 */
export function abandonedClaimWhere(now: Date): Prisma.DeployRequestWhereInput {
  const cutoff = new Date(now.getTime() - DEPLOY_HEARTBEAT_STALE_MS);
  return {
    status: "RUNNING",
    OR: [
      { heartbeatAt: { lt: cutoff } },
      { heartbeatAt: null, claimedAt: { lt: cutoff } },
      { heartbeatAt: null, claimedAt: null, requestedAt: { lt: cutoff } },
    ],
  };
}

/**
 * Mark every dead RUNNING claim ABANDONED. Idempotent and cheap: one
 * `updateMany`, a no-op when nothing is stale. Takes the client as a parameter
 * so this module stays free of a database import.
 */
export async function abandonStaleClaims(
  db: { deployRequest: { updateMany(args: Prisma.DeployRequestUpdateManyArgs): Promise<{ count: number }> } },
  now: Date = new Date(),
): Promise<number> {
  const { count } = await db.deployRequest.updateMany({
    where: abandonedClaimWhere(now),
    data: { status: "ABANDONED", finishedAt: now },
  });
  return count;
}
