/**
 * Sprint and flow panels (dashboards design §5.2 #16–#20): burndown/burnup,
 * sprint status, cumulative flow, throughput, cycle time and work-type mix.
 *
 * The math is the existing pure helpers' (intervals/burndown, dashboard/
 * scope-change, delivery-metrics, cfd), so a dashboard and the board's own
 * views agree. What's new is only the input: the items come from the panel's
 * CQL query as the viewer (`matchingIds`), never from a project-wide read.
 */
import { prisma } from "@/lib/db/client";
import type { CqlNode, CqlQuery } from "@/lib/query/ast";
import { aggregateCql } from "@/lib/query/aggregate.server";
import { burndown } from "@/lib/intervals/burndown";
import { carryover, predictability, scopeChange, type IntervalChange } from "@/lib/dashboard/scope-change";
import { objectiveRollup } from "@/lib/dashboard/impediments";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { cycleTime, throughput, workTypeMix, type DeliveryItemLike } from "@/lib/dashboard/delivery-metrics";
import { cumulativeFlow, type CfdCategory } from "@/lib/dashboard/cfd";
import { rankOf } from "@/lib/classification/effective";
import { andQuery, matchingIds, projectsClassification, relMs, runOptions, workingDaysBetween, type Classifier, type Compute, type PanelRunContext } from "./panel-run.server";

const MS_DAY = 86_400_000;

const INTERVAL = { id: true, name: true, startDate: true, endDate: true, status: true, projectId: true } as const;

/**
 * The sprint a sprint panel is about: the one most of the panel's items sit
 * in, among the sprint the dashboard's filter picked or, unset, the open ones.
 */
async function pickSprint(ctx: PanelRunContext, q: CqlQuery) {
  const scoped = ctx.vars.sprint ? q : andQuery(q, "sprint IN openSprints()");
  const r = await aggregateCql(ctx.auth, { query: scoped }, { dims: [{ field: { kind: "sys", id: "sprint" }, limit: 25 }], measure: { fn: "count" } }, runOptions(ctx));
  const best = r.rows.filter((x) => x.keys[0].id && x.keys[0].id !== "__other__").sort((a, b) => b.count - a.count)[0];
  if (!best) return null;
  return prisma.interval.findFirst({ where: { id: best.keys[0].id!, orgId: ctx.auth.orgId }, select: INTERVAL });
}

const inSprint = (id: string): CqlNode => ({ op: "cmp", field: { kind: "sys", id: "sprint" }, cmp: "eq", value: { t: "ref", entity: "interval", id } });

/** Items of a query with what the pure helpers read, and which are done now. */
async function itemsOf(ctx: PanelRunContext, q: CqlQuery) {
  const [ids, doneIds] = await Promise.all([matchingIds(ctx, q), matchingIds(ctx, andQuery(q, "statusCategory = DONE"))]);
  const done = new Set(doneIds);
  const rows = ids.length
    ? await prisma.workItem.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, ticketNumber: true, intervalId: true, storyPoints: true, actualStart: true, completedAt: true, createdAt: true, columnKey: true, projectId: true, workCategory: true,
          workItemType: { select: { key: true, name: true, color: true } },
        },
      })
    : [];
  return rows.map((r) => ({ ...r, done: done.has(r.id) }));
}


/** The viewer's items that are or were in a sprint, their sprint moves, and the last `n` sprints involved. */
async function sprintHistory(ctx: PanelRunContext, q: CqlQuery, n: number) {
  const items = await itemsOf(ctx, andQuery(q, "(sprint IS NOT EMPTY OR sprint CHANGED)"));
  const acts = items.length
    ? await prisma.activity.findMany({
        where: { orgId: ctx.auth.orgId, workItemId: { in: items.map((i) => i.id) }, field: "intervalId" },
        select: { workItemId: true, oldValue: true, newValue: true, createdAt: true },
      })
    : [];
  const changes: IntervalChange[] = acts.map((a) => ({ workItemId: a.workItemId!, from: a.oldValue, to: a.newValue, at: a.createdAt }));
  const ids = new Set<string>();
  for (const i of items) if (i.intervalId) ids.add(i.intervalId);
  for (const c of changes) for (const x of [c.from, c.to]) if (x) ids.add(x);
  const intervals = (
    await prisma.interval.findMany({
      where: { id: { in: [...ids] }, orgId: ctx.auth.orgId, intervalKind: "SPRINT", projectId: { in: await getReadableProjectIds(ctx.auth) } },
      select: INTERVAL,
      orderBy: { startDate: "desc" },
      take: n,
    })
  ).reverse();
  return { items, changes, intervals, more: ids.size > intervals.length };
}

const noSprint = (cls: Classifier) => ({ data: { sprint: null }, meta: { total: 0, truncated: false, classification: cls.applies ? { level: cls.resolver.orgLevel, markedRows: 0 } : undefined } });

export const FLOW_COMPUTES = {
  burndown: (async ({ query, config }, ctx, cls) => {
    const sprint = await pickSprint(ctx, query);
    if (!sprint) return noSprint(cls);
    const items = await itemsOf(ctx, andQuery(query, inSprint(sprint.id)));
    const series = burndown({ start: sprint.startDate, end: sprint.endDate, today: ctx.now, items, unit: config.unit });
    return {
      data: { sprint: { id: sprint.id, name: sprint.name, start: sprint.startDate.toISOString(), end: sprint.endDate.toISOString() }, mode: config.mode, unit: config.unit, series },
      meta: { total: items.length, truncated: false, classification: projectsClassification(cls, [sprint.projectId]) },
    };
  }) as Compute<"burndown">,

  "sprint-status": (async ({ query }, ctx, cls) => {
    const sprint = await pickSprint(ctx, query);
    if (!sprint) return noSprint(cls);
    const items = await itemsOf(ctx, andQuery(query, inSprint(sprint.id)));
    // Moves in and out of the sprint, for items the viewer can read that were ever in it.
    const everIds = await matchingIds(ctx, { v: 1, where: { op: "was", field: { kind: "sys", id: "sprint" }, values: [{ t: "ref", entity: "interval", id: sprint.id }] } });
    const ids = [...new Set([...items.map((i) => i.id), ...everIds])];
    const acts = ids.length
      ? await prisma.activity.findMany({
          where: { orgId: ctx.auth.orgId, workItemId: { in: ids }, field: "intervalId", OR: [{ oldValue: sprint.id }, { newValue: sprint.id }] },
          select: { workItemId: true, oldValue: true, newValue: true, createdAt: true },
        })
      : [];
    const changes: IntervalChange[] = acts.map((a) => ({ workItemId: a.workItemId!, from: a.oldValue, to: a.newValue, at: a.createdAt }));
    const [row] = scopeChange(changes, [{ ...sprint, status: sprint.status }], items.map((i) => ({ id: i.id, intervalId: sprint.id, done: i.done })));
    const end = sprint.endDate;
    return {
      data: {
        sprint: { id: sprint.id, name: sprint.name, start: sprint.startDate.toISOString(), end: end.toISOString(), status: sprint.status },
        daysRemaining: ctx.now >= end ? 0 : workingDaysBetween(ctx.now, end),
        committed: row?.committed ?? 0,
        current: row?.current ?? items.length,
        completed: row?.completed ?? items.filter((i) => i.done).length,
        added: row?.added ?? 0,
        removed: row?.removed ?? 0,
        commitmentKept: row?.commitmentKept ?? null,
      },
      meta: { total: items.length, truncated: false, classification: projectsClassification(cls, [sprint.projectId]) },
    };
  }) as Compute<"sprint-status">,

  cfd: (async ({ query, config }, ctx, cls) => {
    const days = Math.min(366, Math.max(1, Math.round(-relMs(config.window) / MS_DAY)));
    // Every item, finished ones included: the DONE band is cumulative.
    const relevant = await itemsOf(ctx, query);
    const acts = relevant.length
      ? await prisma.activity.findMany({
          where: { orgId: ctx.auth.orgId, workItemId: { in: relevant.map((i) => i.id) }, field: "columnKey" },
          select: { workItemId: true, oldValue: true, newValue: true, createdAt: true },
        })
      : [];
    const byItem = new Map<string, { at: Date; from: string | null; to: string | null }[]>();
    for (const a of acts) byItem.set(a.workItemId!, [...(byItem.get(a.workItemId!) ?? []), { at: a.createdAt, from: a.oldValue, to: a.newValue }]);
    const columns = await prisma.boardColumn.findMany({
      where: { board: { orgId: ctx.auth.orgId, projectId: { in: [...new Set(relevant.map((i) => i.projectId))] } } },
      select: { key: true, category: true, sortOrder: true, board: { select: { projectId: true } } },
      orderBy: { sortOrder: "asc" },
    });
    const cat = new Map<string, CfdCategory>();
    for (const c of columns) if (!cat.has(`${c.board.projectId}:${c.key}`)) cat.set(`${c.board.projectId}:${c.key}`, c.category as CfdCategory);
    // Category lookups are per project; key the column by it.
    const flow = cumulativeFlow({
      items: relevant.map((i) => ({
        createdAt: i.createdAt,
        completedAt: i.completedAt,
        columnKey: `${i.projectId}:${i.columnKey}`,
        transitions: (byItem.get(i.id) ?? []).map((t) => ({ at: t.at, from: t.from && `${i.projectId}:${t.from}`, to: t.to && `${i.projectId}:${t.to}` })),
      })),
      category: (k) => cat.get(k) ?? "TODO",
      end: ctx.now,
      days,
    });
    return { data: flow, meta: { total: relevant.length, truncated: false, classification: projectsClassification(cls, new Set(relevant.map((i) => i.projectId))) } };
  }) as Compute<"cfd">,

  throughput: (async ({ query, config }, ctx, cls) => {
    const items = await itemsOf(ctx, andQuery(query, "sprint IS NOT EMPTY"));
    const sprintIds = [...new Set(items.map((i) => i.intervalId).filter((x): x is string => !!x))];
    const sprints = (
      await prisma.interval.findMany({ where: { id: { in: sprintIds }, orgId: ctx.auth.orgId, intervalKind: "SPRINT" }, select: INTERVAL, orderBy: { startDate: "desc" }, take: config.sprints })
    ).reverse();
    const keep = new Set(sprints.map((s) => s.id));
    const points = throughput(items.filter((i) => i.intervalId && keep.has(i.intervalId)).map(delivery), sprints);
    return { data: { points }, meta: { total: items.length, truncated: sprintIds.length > config.sprints, classification: projectsClassification(cls, new Set(items.map((i) => i.projectId))) } };
  }) as Compute<"throughput">,

  "cycle-time": (async ({ query, config }, ctx, cls) => {
    const items = await itemsOf(ctx, andQuery(query, `completed >= ${config.window}`));
    return { data: cycleTime(items.map(delivery)), meta: { total: items.length, truncated: false, classification: projectsClassification(cls, new Set(items.map((i) => i.projectId))) } };
  }) as Compute<"cycle-time">,

  "work-type-mix": (async ({ query, config }, ctx, cls) => {
    const items = await itemsOf(ctx, andQuery(query, `completed >= ${config.window}`));
    return { data: workTypeMix(items.map(delivery)), meta: { total: items.length, truncated: false, classification: projectsClassification(cls, new Set(items.map((i) => i.projectId))) } };
  }) as Compute<"work-type-mix">,
  velocity: (async ({ query, config }, ctx, cls) => {
    const h = await sprintHistory(ctx, query, config.sprints);
    const rows = scopeChange(h.changes, h.intervals, h.items.map((i) => ({ id: i.id, intervalId: i.intervalId, done: i.done })));
    const closed = new Set(h.intervals.filter((i) => i.status === "COMPLETED").map((i) => i.id));
    return {
      data: { rows, predictability: predictability(rows, closed) },
      meta: { total: h.items.length, truncated: h.more, classification: projectsClassification(cls, new Set(h.intervals.map((i) => i.projectId))) },
    };
  }) as Compute<"velocity">,

  carryover: (async ({ query, config }, ctx, cls) => {
    const h = await sprintHistory(ctx, query, config.sprints);
    const result = carryover(h.changes, h.intervals);
    const keys = new Map(
      (await prisma.project.findMany({ where: { id: { in: [...new Set(h.items.map((i) => i.projectId))] } }, select: { id: true, key: true } })).map((p) => [p.id, p.key]),
    );
    const byId = new Map(h.items.map((i) => [i.id, `${keys.get(i.projectId)}-${i.ticketNumber}`]));
    return {
      data: { rows: result.rows, repeatOffenders: result.repeatOffenders.filter((r) => byId.has(r.workItemId)).map((r) => ({ ...r, key: byId.get(r.workItemId)! })) },
      meta: { total: h.items.length, truncated: h.more, classification: projectsClassification(cls, new Set(h.intervals.map((i) => i.projectId))) },
    };
  }) as Compute<"carryover">,

  "pi-objectives": (async ({ query }, ctx, cls) => {
    // The active increment most of the panel's items sit in.
    const readable = await getReadableProjectIds(ctx.auth);
    const pis = await prisma.interval.findMany({
      where: { orgId: ctx.auth.orgId, intervalKind: "PROGRAM_INCREMENT", status: "ACTIVE", projectId: { in: ctx.contextProjectId ? readable.filter((p) => p === ctx.contextProjectId) : readable } },
      select: INTERVAL,
    });
    let pi: (typeof pis)[number] | null = null;
    let best = -1;
    for (const p of pis) {
      const r = await aggregateCql(ctx.auth, { query: andQuery(query, { op: "cmp", field: { kind: "sys", id: "pi" }, cmp: "eq", value: { t: "ref", entity: "interval", id: p.id } }) }, { dims: [], measure: { fn: "count" } }, runOptions(ctx));
      if (r.total > best) {
        best = r.total;
        pi = p;
      }
    }
    if (!pi) return { data: { pi: null }, meta: { total: 0, truncated: false, classification: projectsClassification(cls, []) } };
    // Objectives are OKR data: the project's own read rule decides, as on the Objectives tab.
    try {
      await requireProjectRead(ctx.auth, pi.projectId, "OKR_READ");
    } catch {
      return { data: { pi: null }, meta: { total: 0, truncated: false, classification: projectsClassification(cls, []) } };
    }
    const objectives = await prisma.objective.findMany({
      where: { orgId: ctx.auth.orgId, projectId: pi.projectId, intervalId: pi.id },
      select: { id: true, title: true, status: true, progress: true, intervalId: true, committed: true },
      orderBy: { sortOrder: "asc" },
    });
    const roll = objectiveRollup(objectives.map((o) => ({ ...o, status: String(o.status) })), pi.id);
    const mark = (o: { id: string; title: string }) => (cls.applies ? { classification: { level: cls.resolver.rowLevel(pi!.projectId, o.title), marked: cls.resolver.restricted(pi!.projectId, o.title) } } : {});
    return {
      data: {
        pi: { id: pi.id, name: pi.name, start: pi.startDate.toISOString(), end: pi.endDate.toISOString() },
        committed: roll.committed.map((o) => ({ ...o, ...mark(o) })),
        stretch: roll.stretch.map((o) => ({ ...o, ...mark(o) })),
        committedProgress: roll.committedProgress,
        met: roll.met,
      },
      meta: {
        total: objectives.length,
        truncated: false,
        classification: cls.applies
          ? objectives.reduce(
              (m, o) => {
                const l = cls.resolver.rowLevel(pi!.projectId, o.title);
                return { level: (rankOf(l) > rankOf(m.level) ? l : m.level), markedRows: m.markedRows + (cls.resolver.restricted(pi!.projectId, o.title) ? 1 : 0) };
              },
              { level: cls.resolver.levelFor(pi.projectId), markedRows: 0 },
            )
          : undefined,
      },
    };
  }) as Compute<"pi-objectives">,
};

function delivery(i: Awaited<ReturnType<typeof itemsOf>>[number]): DeliveryItemLike {
  return {
    id: i.id,
    intervalId: i.intervalId,
    storyPoints: i.storyPoints,
    actualStart: i.actualStart,
    completedAt: i.completedAt,
    done: i.done,
    typeKey: i.workItemType.key,
    typeName: i.workItemType.name,
    typeColor: i.workItemType.color,
    workCategory: i.workCategory,
  };
}
