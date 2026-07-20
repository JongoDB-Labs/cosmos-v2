// App-side execution of supervisor grooming verdicts, so the console's Apply
// (execute a dry proposal live) and Undo (reverse a live action) buttons work
// WITHOUT importing the daemon-only .mjs modules. Mirrors the daemon's
// executeVerdict semantics (scripts/foreman/supervisor-run.mts) using prisma +
// the GitHub REST API (PR close/reopen) instead of db.mjs + the gh CLI. Every
// action is event-sourced (a `groomed` foreman_event) and reversible.
import { prisma } from "@/lib/db/client";
import { getForemanGithubToken } from "@/lib/ai/foreman-github-pat";
import { parsePrUrl } from "@/lib/foreman/approval-recommendation";

/** The `data` blob on a `groomed` foreman_event (only the fields we read). */
export interface GroomedData {
  action?: string;
  evidence?: string;
  dupOf?: string | null;
  prUrl?: string | null;
  sha?: string;
  priorColumn?: string;
  prClosed?: boolean | null;
  dry?: boolean;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cosmos-foreman",
    "Content-Type": "application/json",
  };
}

/** Set a PR's state ("closed"|"open") via the REST API on Foreman's PAT. Returns
 *  true on success (or when already in that state); false on a real failure. */
async function setPrState(orgId: string, prUrl: string, state: "closed" | "open"): Promise<boolean> {
  const token = await getForemanGithubToken(orgId);
  const t = parsePrUrl(prUrl);
  if (!token || !t) return false;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/pulls/${t.number}`,
      { method: "PATCH", headers: ghHeaders(token), body: JSON.stringify({ state }) },
    );
    return res.ok || res.status === 422; // 422 = already in that state (benign)
  } catch {
    return false;
  }
}

/** Post a PR comment (best-effort) on Foreman's PAT. */
async function prComment(orgId: string, prUrl: string, body: string): Promise<void> {
  const token = await getForemanGithubToken(orgId);
  const t = parsePrUrl(prUrl);
  if (!token || !t) return;
  await fetch(
    `https://api.github.com/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/issues/${t.number}/comments`,
    { method: "POST", headers: ghHeaders(token), body: JSON.stringify({ body }) },
  ).catch(() => undefined);
}

async function moveColumn(itemId: string, columnKey: string): Promise<void> {
  await prisma.workItem.update({ where: { id: itemId }, data: { columnKey, columnEnteredAt: new Date() } });
}

async function addComment(orgId: string, itemId: string, authorId: string, content: string): Promise<void> {
  await prisma.comment.create({ data: { orgId, workItemId: itemId, authorId, content } });
}

/** From groomed events (newest first), the latest whose dry-ness matches `wantDry`.
 *  PURE + unit-tested. We filter in JS rather than pushing a boolean-in-JSON check
 *  into the Prisma WHERE: live events carry NO `dry` key at all, so a
 *  `NOT data.dry = true` filter matches nothing (missing path → NULL → never true) —
 *  the sibling GET route sidesteps the same trap the same way. */
export function pickLatestByDry<T extends { data: unknown }>(events: T[], wantDry: boolean): T | null {
  for (const e of events) {
    const isDry = (e.data as { dry?: unknown } | null)?.dry === true;
    if (isDry === wantDry) return e;
  }
  return null;
}

async function latestGroomed(orgId: string, workItemId: string, wantDry: boolean) {
  const events = await prisma.foremanEvent.findMany({
    where: { orgId, workItemId, kind: "groomed" },
    orderBy: [{ ts: "desc" }, { id: "desc" }],
    take: 30,
    select: { ticketKey: true, data: true },
  });
  return pickLatestByDry(events, wantDry);
}

/**
 * Apply the item's latest DRY grooming proposal for real. The verdict was computed
 * by the trusted daemon, so we re-execute it (close/dedup/requeue/escalate) live and
 * record a non-dry `groomed` event. Returns {applied:false} when there is no dry
 * proposal or the item is gone.
 */
export async function applyGroomedVerdict(
  orgId: string,
  workItemId: string,
  actingUserId: string,
): Promise<{ applied: boolean; action?: string }> {
  const ev = await latestGroomed(orgId, workItemId, true);
  if (!ev) return { applied: false };
  const d = (ev.data ?? {}) as GroomedData;
  const item = await prisma.workItem.findFirst({ where: { id: workItemId, orgId }, select: { columnKey: true } });
  if (!item || !d.action) return { applied: false };

  let prClosed: boolean | undefined;
  if ((d.action === "deliver-close" || d.action === "dedup-consolidate") && d.prUrl) {
    prClosed = await setPrState(orgId, d.prUrl, "closed");
    // Only leave the "delivered/duplicate" note when the close actually succeeded —
    // never claim closure on a PR that's still open.
    if (prClosed) {
      await prComment(
        orgId,
        d.prUrl,
        d.action === "deliver-close"
          ? `Delivered on main (supervisor, applied by a maintainer): ${d.evidence ?? ""}`
          : `Duplicate of ${d.dupOf} (supervisor, applied by a maintainer): ${d.evidence ?? ""}`,
      );
    }
  }
  await prisma.foremanEvent.create({
    data: {
      orgId, workItemId, ticketKey: ev.ticketKey, kind: "groomed", severity: "info",
      message: `${d.action}: ${d.evidence ?? ""}`,
      data: {
        action: d.action, evidence: d.evidence ?? "", dupOf: d.dupOf ?? null, sha: d.sha ?? null,
        priorColumn: item.columnKey, prUrl: d.prUrl ?? null, prClosed: prClosed ?? null, appliedFromDry: true,
      },
    },
  });
  switch (d.action) {
    case "deliver-close":
      await moveColumn(workItemId, "done");
      break;
    case "dedup-consolidate":
      await addComment(orgId, workItemId, actingUserId, `Consolidated into ${d.dupOf} by the supervisor: ${d.evidence ?? ""}`);
      await moveColumn(workItemId, "done");
      break;
    case "requeue":
      await moveColumn(workItemId, "backlog");
      break;
    case "escalate":
      await addComment(orgId, workItemId, actingUserId, `Supervisor needs a human: ${d.evidence ?? ""}`);
      break;
    default:
      return { applied: false };
  }
  return { applied: true, action: d.action };
}

/**
 * Reverse the item's latest LIVE grooming action: reopen the PR (if we closed it),
 * move the card back to its prior column, and leave a note. The board move + note
 * bump the item so the daemon's human-action-respect skips re-grooming it.
 */
export async function undoGroomedAction(
  orgId: string,
  workItemId: string,
  actingUserId: string,
): Promise<{ undone: boolean }> {
  const ev = await latestGroomed(orgId, workItemId, false);
  if (!ev) return { undone: false };
  const d = (ev.data ?? {}) as GroomedData;
  if (d.action === "undo") return { undone: false }; // already undone

  let prReopened: boolean | undefined;
  if ((d.action === "deliver-close" || d.action === "dedup-consolidate") && d.prUrl && d.prClosed) {
    prReopened = await setPrState(orgId, d.prUrl, "open");
    if (prReopened) await prComment(orgId, d.prUrl, "Reopened — a maintainer undid the supervisor's action.");
  }
  await prisma.foremanEvent.create({
    data: {
      orgId, workItemId, ticketKey: ev.ticketKey, kind: "groomed", severity: "info",
      message: `undo: reversed ${d.action}`,
      // Record the reopen result (like Apply records prClosed) so a failed reopen is
      // visible in the event history, not silently lost.
      data: { action: "undo", of: d.action ?? null, prReopened: prReopened ?? null, evidence: `reversed ${d.action ?? "action"}` },
    },
  });
  if (d.priorColumn) await moveColumn(workItemId, d.priorColumn);
  await addComment(orgId, workItemId, actingUserId, `Undid the supervisor's "${d.action}" on this item.`);
  return { undone: true };
}
