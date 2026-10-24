// What the host-side installer (the Foreman daemon) found on its last pass.
//
// WHY THIS EXISTS. Production stopped installing updates silently: the page
// said "Automatic" and showed a newer version available while the instance sat
// several releases behind, and the only explanation was a log file on the host.
// A switch that says "Automatic" is a claim about what the daemon does; this
// table is the daemon's own account of whether it is doing it, and the page
// shows that next to the switch.
//
// THE CONTRACT BELOW IS SHARED with the Foreman plugin (a separate repository)
// — the daemon calls recordReconcileStatus() every pass. Do not rename anything
// exported here without changing the plugin in the same release.
//
// Core owns it for the same reason as UpdateSettings: CI builds core with no
// plugins composed, so core cannot reference a plugin model, and the page that
// owns the switch has to be able to say whether the switch is being honoured.
import { prisma } from "@/lib/db/client";
import { formatDateTimeStable } from "@/lib/format/stable-date";

export const RECONCILE_STATUS_SCOPE = "instance";

/**
 * - "up-to-date": running the newest release.
 * - "deployed": installed a newer release on this pass.
 * - "waiting-manual": a newer release is ready; the switch says Manual.
 * - "pending": a newer release exists but its image is not built/visible yet —
 *   normal for the first half hour or so of every release. Written on EVERY pass
 *   during that window, so checkedAt stays fresh.
 * - "failing": the install (or the check itself) is failing.
 */
export type ReconcileOutcome = "up-to-date" | "deployed" | "waiting-manual" | "pending" | "failing";

export interface ReconcileReport {
  outcome: ReconcileOutcome;
  message: string;
  latestReleased: string | null;
  runningVersion: string | null;
  source: string | null;
}

export interface ReconcileStatusDto extends ReconcileReport {
  checkedAt: string;
  failingSince: string | null;
}

/**
 * Past this, a report is no longer evidence that the installer is running. The
 * daemon reports on every pass (minutes apart), so ten minutes of silence means
 * it has stopped, crashed, or lost the database — and in every one of those
 * cases the switch on the page is not being acted on.
 */
export const RECONCILE_STALE_MS = 10 * 60_000;

/**
 * Record one pass. Upserts the singleton on its unique scope; `checkedAt` is
 * `now`. `failingSince` marks the START of the current failing streak: kept
 * while the outcome stays "failing", set to `now` when it starts failing, and
 * cleared by any other outcome.
 *
 * THROWS on a DB failure. The daemon catches it — failing to write a report
 * must never be what stops an install.
 */
export async function recordReconcileStatus(report: ReconcileReport, now: Date = new Date()): Promise<void> {
  let failingSince: Date | null = null;
  if (report.outcome === "failing") {
    const prior = await prisma.updateReconcileStatus.findUnique({
      where: { scope: RECONCILE_STATUS_SCOPE },
      select: { outcome: true, failingSince: true },
    });
    failingSince = prior?.outcome === "failing" && prior.failingSince ? prior.failingSince : now;
  }

  const data = {
    outcome: report.outcome,
    message: report.message,
    latestReleased: report.latestReleased,
    runningVersion: report.runningVersion,
    source: report.source,
    checkedAt: now,
    failingSince,
  };
  await prisma.updateReconcileStatus.upsert({
    where: { scope: RECONCILE_STATUS_SCOPE },
    create: { scope: RECONCILE_STATUS_SCOPE, ...data },
    update: data,
    select: { id: true },
  });
}

/** The last report, or null if the installer has never reported. THROWS on a
 *  DB failure — "could not read" is not the same as "never reported". */
export async function getReconcileStatus(): Promise<ReconcileStatusDto | null> {
  const row = await prisma.updateReconcileStatus.findUnique({
    where: { scope: RECONCILE_STATUS_SCOPE },
    select: {
      outcome: true,
      message: true,
      latestReleased: true,
      runningVersion: true,
      source: true,
      checkedAt: true,
      failingSince: true,
    },
  });
  if (!row) return null;
  return {
    // Stored as text so the plugin can add an outcome without a core
    // migration; describeReconcileHealth treats one it does not know as a warning.
    outcome: row.outcome as ReconcileOutcome,
    message: row.message,
    latestReleased: row.latestReleased,
    runningVersion: row.runningVersion,
    source: row.source,
    checkedAt: row.checkedAt.toISOString(),
    failingSince: row.failingSince?.toISOString() ?? null,
  };
}

/** "3 minutes ago" — coarse on purpose; the exact time is shown next to it. */
function ago(iso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(iso).getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

/** Absolute (UTC, stable across server and client) plus relative. */
function when(iso: string, now: Date): string {
  return `${formatDateTimeStable(iso)} UTC (${ago(iso, now)})`;
}

/**
 * One health line for the page, from the last report. Pure.
 *
 * Wording is for an operator, not for whoever wrote the daemon: it says what is
 * or is not happening to their updates.
 */
export function describeReconcileHealth(
  status: ReconcileStatusDto | null,
  autoUpdate: boolean,
  now: Date,
): { tone: "ok" | "warn" | "error" | "muted"; headline: string; detail: string | null } {
  if (!status) {
    return {
      tone: "muted",
      headline: "The automatic installer hasn't reported in yet",
      detail:
        "If this instance relies on Foreman to install updates, Foreman may not be running on the host, " +
        "or may not be set up for this instance (check FOREMAN_INSTANCE). Until it reports, this page " +
        "cannot confirm that updates are being " +
        (autoUpdate ? "installed." : "checked."),
    };
  }

  const age = now.getTime() - new Date(status.checkedAt).getTime();
  if (age > RECONCILE_STALE_MS) {
    return {
      tone: "error",
      headline: "The automatic installer has gone quiet",
      detail:
        `It last checked for updates at ${when(status.checkedAt, now)}. Until it is running again, ` +
        `new versions are not being ${autoUpdate ? "installed" : "looked for"} — check the installer on the host.`,
    };
  }

  switch (status.outcome) {
    case "failing":
      return {
        tone: "error",
        headline: status.latestReleased
          ? `Installing ${status.latestReleased} is failing`
          : "The automatic installer is failing",
        detail: status.failingSince
          ? `${status.message} — failing since ${when(status.failingSince, now)}.`
          : status.message,
      };
    case "waiting-manual":
      return {
        tone: "warn",
        headline: status.latestReleased
          ? `${status.latestReleased} is ready and waiting for you to install it`
          : "A newer version is waiting for you to install it",
        detail: autoUpdate
          ? `${status.message} The installer last saw this instance set to Manual; it will start installing on its next check.`
          : status.message,
      };
    case "pending":
      // Not a problem: every release spends a while here while its image builds.
      return {
        tone: "muted",
        headline: status.latestReleased
          ? `A newer version (${status.latestReleased}) is on its way`
          : "A newer version is on its way",
        detail: autoUpdate
          ? "It installs automatically once its image is built."
          : "It will be ready to install here once its image is built.",
      };
    case "deployed":
      return {
        tone: "ok",
        headline: status.runningVersion
          ? `Installed ${status.runningVersion} automatically`
          : "Installed the newest version automatically",
        detail: status.message,
      };
    case "up-to-date":
      return {
        tone: "ok",
        headline: status.runningVersion
          ? `Running the newest release (${status.runningVersion})`
          : "Running the newest release",
        detail: status.message,
      };
    default:
      // An outcome a newer daemon reports that this page does not know yet.
      return { tone: "warn", headline: "The automatic installer reported something unexpected", detail: status.message };
  }
}
