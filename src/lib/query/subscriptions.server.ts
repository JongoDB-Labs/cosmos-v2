/**
 * Filter subscriptions (query design §12.4): a saved filter emailed on a
 * schedule. The rules, from Jira's:
 *
 *   - Anyone may subscribe THEMSELVES to a filter they can see.
 *   - Subscribing a TEAM takes being on it AND managing its project, and the
 *     filter must be visible to the team (shared with it, its project, or the
 *     org): a team subscription never widens who can see a filter.
 *   - The query runs once per recipient AS that recipient: their readable
 *     projects, `me` is them. Nobody is ever sent a row they couldn't open.
 *   - A recipient who left the org, or can no longer see the filter, gets
 *     nothing. A one-person subscription is then disabled with the reason;
 *     a team member is just skipped.
 *
 * The run (`runDueSubscriptions`) claims due rows with FOR UPDATE SKIP LOCKED
 * and moves `next_run_at` on in the same transaction, so two ticks (or two
 * instances) never send one schedule twice.
 */
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { sendAppEmail } from "@/lib/integrations/email-sender";
import { logAudit } from "@/lib/audit";
import { executeCql } from "./execute.server";
import { canSee, storedQuery, viewerScope, type ViewAccessRow, type ViewerScope } from "./saved-filters.server";
import { cqlEmailTitles, cqlEnabled } from "./flag";
import { checkSchedule, nextRun, parseSchedule } from "./schedule";
import { CqlError } from "./errors";
import { tooLateToSend } from "@/lib/jobs/side-effect-window";
import { buildSubscriptionEmail, unsubscribeToken, type EmailRow } from "./subscription-email";

/** Ids kept per recipient for "only new items". */
const CHANGE_IDS_MAX = 100;
/** Subscriptions claimed per batch. */
const BATCH = 50;

export const SUBSCRIPTION_SELECT = {
  id: true,
  savedViewId: true,
  createdById: true,
  recipientUserId: true,
  recipientTeamId: true,
  cron: true,
  timezone: true,
  format: true,
  sendWhenEmpty: true,
  onlyChanges: true,
  lastRunAt: true,
  nextRunAt: true,
  disabledAt: true,
  disabledReason: true,
  lastError: true,
  createdAt: true,
  recipientUser: { select: { id: true, displayName: true } },
  recipientTeam: { select: { id: true, name: true } },
} as const satisfies Prisma.FilterSubscriptionSelect;
export type SubscriptionRow = Prisma.FilterSubscriptionGetPayload<{ select: typeof SUBSCRIPTION_SELECT }>;

const VIEW_ACCESS = {
  id: true,
  orgId: true,
  name: true,
  ownerId: true,
  visibility: true,
  projectId: true,
  teamId: true,
  query: true,
  filter: true,
  editors: { select: { userId: true } },
} as const satisfies Prisma.SavedViewSelect;
type ViewRow = Prisma.SavedViewGetPayload<{ select: typeof VIEW_ACCESS }>;

export async function loadView(orgId: string, viewId: string): Promise<ViewRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(viewId)) return null;
  return prisma.savedView.findFirst({ where: { id: viewId, orgId }, select: VIEW_ACCESS });
}

/** Is the filter visible to everyone on this team (not just to the subscriber)? */
function visibleToTeam(view: ViewAccessRow, team: { id: string; projectId: string }): boolean {
  return (
    view.visibility === "ORG" ||
    (view.visibility === "PROJECT" && view.projectId === team.projectId) ||
    (view.visibility === "TEAM" && view.teamId === team.id)
  );
}

export interface SubscriptionInput {
  recipient: { kind: "me" } | { kind: "team"; teamId: string };
  cron: string;
  timezone: string;
  format?: "LIST" | "COUNT";
  sendWhenEmpty?: boolean;
  onlyChanges?: boolean;
}

/** Why this actor can't make this subscription, or null. */
export async function subscriptionProblem(s: ViewerScope, view: ViewAccessRow, input: SubscriptionInput, now = new Date()): Promise<string | null> {
  if (!canSee(s, view)) return "Filter not found";
  const sched = checkSchedule(input.cron, input.timezone, now);
  if ("error" in sched) return sched.error;
  if (input.recipient.kind === "team") {
    const teamId = input.recipient.teamId;
    const projectId = s.teams.get(teamId);
    if (!projectId) return "You can only subscribe a team you're on.";
    try {
      await requireProjectManage(s.ctx, projectId, Permission.PROJECT_UPDATE);
    } catch {
      return "Subscribing a team takes managing its project.";
    }
    if (!visibleToTeam(view, { id: teamId, projectId })) {
      return "Share the filter with this team, its project or the organization first, so every member can see it.";
    }
  }
  return null;
}

/** Who may change or delete a subscription: its creator, its one-person recipient, or an org admin. */
export function canManageSubscription(s: ViewerScope, sub: { createdById: string; recipientUserId: string | null }): boolean {
  return sub.createdById === s.ctx.userId || sub.recipientUserId === s.ctx.userId || s.isAdmin;
}

/** The subscriptions on a filter this actor should see: theirs, ones that reach them, or all for an admin. */
export async function listSubscriptions(s: ViewerScope, viewId: string): Promise<SubscriptionRow[]> {
  const mine: Prisma.FilterSubscriptionWhereInput[] = [
    { createdById: s.ctx.userId },
    { recipientUserId: s.ctx.userId },
    { recipientTeamId: { in: [...s.teams.keys()] } },
  ];
  return prisma.filterSubscription.findMany({
    where: { orgId: s.ctx.orgId, savedViewId: viewId, ...(s.isAdmin ? {} : { OR: mine }) },
    select: SUBSCRIPTION_SELECT,
    orderBy: { createdAt: "asc" },
  });
}

export async function createSubscription(s: ViewerScope, view: ViewRow, input: SubscriptionInput, origin: string, now = new Date()) {
  const sched = checkSchedule(input.cron, input.timezone, now) as { next: Date };
  const row = await prisma.filterSubscription.create({
    data: {
      orgId: s.ctx.orgId,
      savedViewId: view.id,
      createdById: s.ctx.userId,
      recipientUserId: input.recipient.kind === "me" ? s.ctx.userId : null,
      recipientTeamId: input.recipient.kind === "team" ? input.recipient.teamId : null,
      cron: input.cron.trim(),
      timezone: input.timezone,
      format: input.format ?? "LIST",
      sendWhenEmpty: input.sendWhenEmpty ?? false,
      onlyChanges: input.onlyChanges ?? false,
      nextRunAt: sched.next,
      unsubscribeKey: randomBytes(32).toString("hex"),
      appOrigin: origin,
    },
    select: SUBSCRIPTION_SELECT,
  });
  await logAudit({
    orgId: s.ctx.orgId, userId: s.ctx.userId, action: "saved_filter.subscribed", entity: "saved_view", entityId: view.id,
    metadata: { subscriptionId: row.id, recipient: input.recipient.kind === "team" ? { teamId: input.recipient.teamId } : "self", cron: row.cron },
  });
  return row;
}

/** Re-enabling clears the reason; a schedule change moves the next run. */
export async function updateSubscription(
  s: ViewerScope,
  sub: { id: string; savedViewId: string; cron: string; timezone: string },
  patch: Partial<Omit<SubscriptionInput, "recipient">> & { enabled?: boolean },
  origin: string,
  now = new Date(),
) {
  const cron = patch.cron ?? sub.cron;
  const timezone = patch.timezone ?? sub.timezone;
  const sched = checkSchedule(cron, timezone, now) as { next: Date };
  const row = await prisma.filterSubscription.update({
    where: { id: sub.id },
    data: {
      cron: cron.trim(),
      timezone,
      ...(patch.format ? { format: patch.format } : {}),
      ...(patch.sendWhenEmpty !== undefined ? { sendWhenEmpty: patch.sendWhenEmpty } : {}),
      ...(patch.onlyChanges !== undefined ? { onlyChanges: patch.onlyChanges } : {}),
      ...(patch.enabled === true ? { disabledAt: null, disabledReason: null, lastError: null } : {}),
      ...(patch.enabled === false ? { disabledAt: now, disabledReason: "paused" } : {}),
      nextRunAt: sched.next,
      appOrigin: origin,
    },
    select: SUBSCRIPTION_SELECT,
  });
  await logAudit({
    orgId: s.ctx.orgId, userId: s.ctx.userId, action: "saved_filter.subscription_updated", entity: "saved_view", entityId: sub.savedViewId,
    metadata: { subscriptionId: sub.id, ...patch },
  });
  return row;
}

export async function deleteSubscription(s: ViewerScope, sub: { id: string; savedViewId: string }) {
  await prisma.filterSubscription.delete({ where: { id: sub.id } });
  await logAudit({
    orgId: s.ctx.orgId, userId: s.ctx.userId, action: "saved_filter.unsubscribed", entity: "saved_view", entityId: sub.savedViewId,
    metadata: { subscriptionId: sub.id },
  });
}

// ── The run ────────────────────────────────────────────────────────────────

export type SendFn = (msg: { to: string; subject: string; text: string; html: string; orgId: string }) => Promise<void>;

export interface RunSummary {
  subscriptions: number;
  sent: number;
  skipped: number;
  disabled: number;
  failed: number;
  /** Slots missed by more than the window (the jobs were down): moved on, not sent late. */
  missed: number;
}

interface Claimed {
  id: string;
}

interface ClaimedRun {
  id: string;
  /** Its slot passed more than SIDE_EFFECT_WINDOW_MS ago. */
  late: boolean;
}

/** Claim due subscriptions and move their next run on, atomically. */
async function claim(now: Date): Promise<ClaimedRun[]> {
  return prisma.$transaction(async (tx) => {
    const due = await tx.$queryRaw<(Claimed & { cron: string; timezone: string; next_run_at: Date })[]>(Prisma.sql`
      SELECT id, cron, timezone, next_run_at FROM filter_subscriptions
      WHERE next_run_at <= ${now} AND disabled_at IS NULL
      ORDER BY next_run_at
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED`);
    for (const d of due) {
      const sched = parseSchedule(d.cron);
      const next = "error" in sched ? null : nextRun(sched, d.timezone, now);
      await tx.filterSubscription.update({
        where: { id: d.id },
        data: next
          ? { nextRunAt: next, lastRunAt: now }
          : { lastRunAt: now, disabledAt: now, disabledReason: "schedule no longer runs" },
      });
    }
    return due.map((d) => ({ id: d.id, late: tooLateToSend(d.next_run_at, now) }));
  });
}

/** Run everything due, in batches, until nothing is due or the signal aborts. */
export async function runDueSubscriptions(opts: { now?: Date; signal?: AbortSignal; send?: SendFn } = {}): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const send: SendFn = opts.send ?? ((m) => sendAppEmail(m));
  const summary: RunSummary = { subscriptions: 0, sent: 0, skipped: 0, disabled: 0, failed: 0, missed: 0 };
  for (;;) {
    if (opts.signal?.aborted) break;
    const ids = await claim(now);
    if (ids.length === 0) break;
    for (const { id, late } of ids) {
      if (opts.signal?.aborted) break;
      summary.subscriptions++;
      // Its slot went by while the jobs were down: the claim already moved it
      // to the next one, and yesterday's digest today would be noise.
      if (late) {
        summary.missed++;
        continue;
      }
      try {
        const r = await runOne(id, send);
        summary.sent += r.sent;
        summary.skipped += r.skipped;
        if (r.disabled) summary.disabled++;
      } catch (e) {
        summary.failed++;
        await prisma.filterSubscription
          .update({ where: { id }, data: { lastError: e instanceof Error ? e.message.slice(0, 500) : "failed" } })
          .catch(() => undefined);
      }
    }
    if (ids.length < BATCH) break;
  }
  return summary;
}

async function disable(id: string, reason: string) {
  await prisma.filterSubscription.update({ where: { id }, data: { disabledAt: new Date(), disabledReason: reason } });
}

/** Send one subscription to each of its recipients. Exported for tests. */
export async function runOne(id: string, send: SendFn): Promise<{ sent: number; skipped: number; disabled: boolean }> {
  const sub = await prisma.filterSubscription.findUnique({
    where: { id },
    include: {
      org: { select: { slug: true, settings: true, tenantClass: true } },
      savedView: { select: VIEW_ACCESS },
      recipientTeam: { select: { id: true, name: true, projectId: true } },
    },
  });
  if (!sub || sub.disabledAt) return { sent: 0, skipped: 0, disabled: false };
  // The switch off: nothing goes out, and nothing is disabled either.
  if (!cqlEnabled(sub.org.settings)) return { sent: 0, skipped: 1, disabled: false };

  let recipients: { userId: string; reason: string }[];
  if (sub.recipientUserId) {
    recipients = [{ userId: sub.recipientUserId, reason: "you subscribed to this filter" }];
  } else if (sub.recipientTeam) {
    const muted = new Set(sub.mutedUserIds);
    const members = await prisma.teamMember.findMany({
      where: { teamId: sub.recipientTeam.id },
      select: { projectMember: { select: { orgMember: { select: { userId: true } } } } },
    });
    const reason = `your team ${sub.recipientTeam.name} is subscribed to this filter`;
    recipients = members.map((m) => ({ userId: m.projectMember.orgMember.userId, reason })).filter((r) => !muted.has(r.userId));
    // A team subscription only ever reaches the team while the filter is shared with it.
    if (!visibleToTeam(sub.savedView, sub.recipientTeam)) {
      await disable(sub.id, "filter no longer shared with the team");
      return { sent: 0, skipped: recipients.length, disabled: true };
    }
  } else {
    await disable(sub.id, "recipient removed");
    return { sent: 0, skipped: 0, disabled: true };
  }

  const includeTitles = cqlEmailTitles(sub.org.settings, sub.org.tenantClass);
  const lastIds = (sub.lastResultIds ?? {}) as Record<string, string[]>;
  const nextIds: Record<string, string[]> = { ...lastIds };
  const errors: string[] = [];
  let sent = 0;
  let skipped = 0;

  for (const r of recipients) {
    const auth: AuthContext | null = await loadMemberAuthContext(sub.orgId, r.userId);
    const scope = auth ? await viewerScope(auth) : null;
    if (!auth || !scope || !canSee(scope, sub.savedView)) {
      if (sub.recipientUserId) {
        await disable(sub.id, auth ? "filter no longer visible to the recipient" : "recipient is no longer a member");
        return { sent, skipped: skipped + 1, disabled: true };
      }
      skipped++;
      continue;
    }
    const user = await prisma.user.findUnique({ where: { id: r.userId }, select: { email: true } });
    if (!user?.email) {
      skipped++;
      continue;
    }

    let result: Awaited<ReturnType<typeof executeCql>>;
    try {
      result = await executeCql(auth, { query: storedQuery(sub.savedView) }, {
        pageSize: CHANGE_IDS_MAX,
        tz: sub.timezone,
        timeoutMs: 10_000,
        countTimeoutMs: 5_000,
        sequential: true,
      });
    } catch (e) {
      if (!(e instanceof CqlError)) throw e;
      errors.push(`query: ${e.message}`);
      skipped++;
      continue;
    }

    const ids = result.data.map((row) => row.id);
    const before = new Set(lastIds[r.userId] ?? []);
    const rows: EmailRow[] = (sub.onlyChanges ? result.data.filter((row) => !before.has(row.id)) : result.data).map((row) => ({
      id: row.id, ticketKey: row.ticketKey, title: row.title, columnKey: row.columnKey,
    }));
    nextIds[r.userId] = ids;
    const empty = sub.onlyChanges ? rows.length === 0 : result.total === 0 || ids.length === 0;
    if (empty && !sub.sendWhenEmpty) {
      skipped++;
      continue;
    }

    const email = buildSubscriptionEmail({
      filterName: sub.savedView.name,
      origin: sub.appOrigin,
      orgSlug: sub.org.slug,
      viewId: sub.savedViewId,
      rows,
      total: result.total,
      onlyChanges: sub.onlyChanges,
      format: sub.format,
      includeTitles,
      reason: r.reason,
      unsubscribeUrl: `${sub.appOrigin}/api/v1/unsubscribe/filter/${unsubscribeToken(sub.unsubscribeKey, sub.id, r.userId)}`,
    });
    try {
      await send({ to: user.email, ...email, orgId: sub.orgId });
      sent++;
    } catch (e) {
      errors.push(`email: ${e instanceof Error ? e.message.slice(0, 200) : "failed"}`);
      // Not sent: don't remember these ids as sent.
      nextIds[r.userId] = lastIds[r.userId] ?? [];
      skipped++;
    }
  }

  await prisma.filterSubscription.update({
    where: { id: sub.id },
    data: { lastResultIds: nextIds, lastError: errors.length ? [...new Set(errors)].join("; ").slice(0, 500) : null },
  });
  return { sent, skipped, disabled: false };
}
