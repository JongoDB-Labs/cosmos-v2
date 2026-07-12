// Server-side assembly of the Foreman console payload. Read-only.
import { prisma } from "@/lib/db/client";
import { readAutomationConfig } from "@/lib/feedback/automation-config";
import { pulseFor, PARKED_EVENT_KINDS, type InFlightBuild } from "@/lib/foreman/observe";
import { PRIORITY_RANK } from "@/lib/foreman/queue";

export type ForemanStatusPayload = {
  state: null | {
    pulse: ReturnType<typeof pulseFor>;
    lastPassAt: string; startedAt: string; daemonVersion: string;
    workerTarget: number; slotsBusy: number; queueDepth: number;
    breaker: { build: number; deploy: number; tripped: boolean };
    stopFileSeen: boolean;
  };
  paused: boolean;
  /** Foreman's planned To-do queue, in claim order (priority tier, then FIFO —
   *  mirrors queue.ts's pickNext ordering). `why` is the latest `planned`
   *  event's one-line rationale, null for a todo item a human moved there
   *  directly (Foreman never planned it). No permission/member fields. */
  upNext: { workItemId: string; projectId: string; ticketKey: string | null; title: string; why: string | null; since: string }[];
  inFlight: InFlightBuild[];
  awaitingApproval: { workItemId: string; projectId: string; ticketKey: string | null; title: string; reason: string | null; prUrl: string | null; parkedAt: string }[];
  config: ReturnType<typeof readAutomationConfig>;
  hasHistory: boolean;
  /** Whether the requesting actor may STEER the autonomous deployer (Approve /
   *  Rebuild). This is the BASE org role (OWNER/ADMIN) — matching the daemon's own
   *  privilegedUserIds gate — NOT the effective ORG_UPDATE permission, which a
   *  work-role can widen onto a MEMBER whose comments the daemon would ignore.
   *  Computed route-side and threaded in; the cards stay visible read-only when
   *  false, only the steering buttons hide. */
  actorCanSteer: boolean;
};

export async function assembleStatus(orgId: string, actorCanSteer = false): Promise<ForemanStatusPayload> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  const config = readAutomationConfig(org?.settings ?? {});
  const paused = !config.autonomousDelivery.enabled;

  const row = await prisma.foremanState.findUnique({ where: { id: "host" } });
  const breaker = (row?.breaker ?? { build: 0, deploy: 0, tripped: false }) as { build: number; deploy: number; tripped: boolean };
  const allInFlight = Array.isArray(row?.inFlight) ? (row.inFlight as InFlightBuild[]) : [];
  const state = row
    ? {
        pulse: pulseFor({ lastPassAt: row.lastPassAt, paused, breakerTripped: breaker.tripped, stopFileSeen: row.stopFileSeen }),
        lastPassAt: row.lastPassAt.toISOString(), startedAt: row.startedAt.toISOString(),
        daemonVersion: row.daemonVersion, workerTarget: row.workerTarget,
        slotsBusy: row.slotsBusy, queueDepth: row.queueDepth, breaker, stopFileSeen: row.stopFileSeen,
      }
    : null;

  const projectIds = config.autonomousDelivery.projectIds;
  const parked = projectIds.length
    ? await prisma.workItem.findMany({
        where: { orgId, projectId: { in: projectIds }, columnKey: "review" },
        select: { id: true, projectId: true, title: true, columnEnteredAt: true },
        orderBy: { columnEnteredAt: "desc" },
        take: 50,
      })
    : [];
  const events = parked.length
    ? await prisma.foremanEvent.findMany({
        where: {
          workItemId: { in: parked.map((w) => w.id) },
          kind: { in: [...PARKED_EVENT_KINDS] },
        },
        orderBy: { ts: "desc" },
      })
    : [];
  // Pick, per item, the newest event that actually carries a reason (data.reason),
  // falling back to the newest listed event of any kind. Blindly taking the latest
  // (the old `distinct`) let a later reason-less `gated`/`ship-failed` blank the
  // reason/prUrl a prior `parked` recorded. `events` is ts-desc, so the first hit
  // per item is the newest of its category.
  const newestByItem = new Map<string, (typeof events)[number]>();
  const reasonedByItem = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    if (!e.workItemId) continue;
    if (!newestByItem.has(e.workItemId)) newestByItem.set(e.workItemId, e);
    const hasReason = ((e.data ?? {}) as { reason?: unknown }).reason != null;
    if (hasReason && !reasonedByItem.has(e.workItemId)) reasonedByItem.set(e.workItemId, e);
  }
  const latestByItem = new Map(
    parked.map((w) => [w.id, reasonedByItem.get(w.id) ?? newestByItem.get(w.id)] as const),
  );
  const awaitingApproval = parked.map((wi) => {
    const ev = latestByItem.get(wi.id);
    const data = (ev?.data ?? {}) as { reason?: string; prUrl?: string };
    return {
      workItemId: wi.id, projectId: wi.projectId, ticketKey: ev?.ticketKey ?? null, title: wi.title,
      reason: data.reason ?? ev?.message ?? null, prUrl: data.prUrl ?? null,
      parkedAt: (wi.columnEnteredAt ?? new Date()).toISOString(),
    };
  });

  // Up next: the To-do column for the same delivery pool, claim-ordered
  // (priority tier then FIFO — same comparator queue.pickNext/planner's
  // rankAndCapCandidates use). ticketKey comes from the work item's own
  // project key + ticket number (always present, unlike an event-sourced
  // key) — every real ticket gets a link, not just ones Foreman has touched.
  // WorkItem has no Prisma relation to Project (projectId is a plain FK
  // column) — batch-resolve keys the same way src/lib/work-items/query/
  // project.ts does, rather than an `include`.
  const todo = projectIds.length
    ? await prisma.workItem.findMany({
        where: { orgId, projectId: { in: projectIds }, columnKey: "todo" },
        select: {
          id: true, projectId: true, title: true, priority: true, ticketNumber: true,
          columnEnteredAt: true,
        },
        orderBy: { columnEnteredAt: "asc" },
        take: 50,
      })
    : [];
  const [plannedEvents, todoProjects] = todo.length
    ? await Promise.all([
        prisma.foremanEvent.findMany({
          where: { workItemId: { in: todo.map((w) => w.id) }, kind: "planned" },
          orderBy: { ts: "desc" },
        }),
        prisma.project.findMany({
          where: { id: { in: [...new Set(todo.map((w) => w.projectId))] } },
          select: { id: true, key: true },
        }),
      ])
    : [[], []];
  // Latest `planned` event per item — the join exists only to source `why`;
  // `events` is ts-desc, so the first hit per item is the newest.
  const latestPlannedByItem = new Map<string, (typeof plannedEvents)[number]>();
  for (const e of plannedEvents) {
    if (!e.workItemId) continue;
    if (!latestPlannedByItem.has(e.workItemId)) latestPlannedByItem.set(e.workItemId, e);
  }
  const projectKeyById = new Map(todoProjects.map((p) => [p.id, p.key]));
  const upNext = [...todo]
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        (a.columnEnteredAt?.getTime() ?? 0) - (b.columnEnteredAt?.getTime() ?? 0),
    )
    .map((wi) => {
      const ev = latestPlannedByItem.get(wi.id);
      const why = ((ev?.data ?? {}) as { why?: string }).why ?? null;
      const projectKey = projectKeyById.get(wi.projectId) ?? "";
      return {
        workItemId: wi.id, projectId: wi.projectId, ticketKey: `${projectKey}-${wi.ticketNumber}`,
        title: wi.title, why, since: (wi.columnEnteredAt ?? new Date()).toISOString(),
      };
    });

  const hasHistory = (await prisma.foremanEvent.count({ where: { orgId } })) > 0;
  return { state, paused, upNext, inFlight: allInFlight.filter((b) => b.orgId === orgId), awaitingApproval, config, hasHistory, actorCanSteer };
}
