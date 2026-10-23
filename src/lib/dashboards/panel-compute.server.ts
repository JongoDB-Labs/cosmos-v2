/**
 * Server computes for every panel type in panel-registry.ts (dashboards design
 * §5.2). Each takes the panel's query, already ANDed with the dashboard's
 * filters, and the viewer's run context, and reads work items only through
 * the CQL executor (panel-run.server.ts). Nothing here builds its own
 * work-item where, so nothing here can widen what the viewer sees.
 */
import { prisma } from "@/lib/db/client";
import type { CqlQuery, FieldRef } from "@/lib/query/ast";
import { aggregateCql } from "@/lib/query/aggregate.server";
import { OTHER_ID, type AggDim, type AggMeasure, type AggRow } from "@/lib/query/aggregate";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { RESTRICTED } from "@/lib/query/saved-filters.server";
import type { PanelType } from "./panel-registry";
import {
  andQuery,
  listRows,
  matchingIds,
  orderedBy,
  projectsClassification,
  rowsClassification,
  runOptions,
  toPanelRows,
  type Classifier,
  type PanelRow,
  type PanelRunContext,
  relMs,
  workingDaysBetween,
  type Compute,
} from "./panel-run.server";
import { FLOW_COMPUTES } from "./panel-flow.server";

const MS_DAY = 86_400_000;

// The registry's zod configs are checked against the field registry by the
// aggregate engine (aggProblem); here they only need the narrower types.
const m = (x: unknown) => x as AggMeasure;
const fr = (x: unknown) => x as FieldRef;

async function rowsPanel(ctx: PanelRunContext, cls: Classifier, q: CqlQuery, limit: number) {
  const { rows, total, cql } = await listRows(ctx, q, limit);
  const out = await toPanelRows(ctx, rows, cls);
  return { rows: out, meta: { total, truncated: total === null || total > out.length, classification: rowsClassification(cls, out), cql } };
}

/** The projects a chart's numbers can come from: the viewer's readable ones (the context project's, when set). */
async function chartProjects(ctx: PanelRunContext): Promise<string[]> {
  const readable = await getReadableProjectIds(ctx.auth);
  return ctx.contextProjectId ? readable.filter((p) => p === ctx.contextProjectId) : readable;
}

async function aggregate(ctx: PanelRunContext, q: CqlQuery, dims: AggDim[], measure: AggMeasure) {
  return aggregateCql(ctx.auth, { query: q }, { dims, measure }, runOptions(ctx));
}

const groupLabel = (r: PanelRow, by: "assignee" | "status" | "sprint" | "priority") =>
  by === "assignee" ? (r.assignee?.name ?? "Unassigned") : by === "status" ? r.status : by === "sprint" ? (r.sprint?.name ?? "No sprint") : r.priority;

// ── Lists ─────────────────────────────────────────────────────────────────

const itemList: Compute<"item-list"> = async ({ query, config }, ctx, cls) => {
  const { rows, meta } = await rowsPanel(ctx, cls, query, config.limit);
  const groups = config.groupBy
    ? [...rows.reduce((m, r) => m.set(groupLabel(r, config.groupBy!), [...(m.get(groupLabel(r, config.groupBy!)) ?? []), r.id]), new Map<string, string[]>())].map(
        ([label, ids]) => ({ label, ids }),
      )
    : null;
  return { data: { columns: config.columns, rows, groups }, meta };
};

const standupWalk: Compute<"standup-walk"> = async ({ query, config }, ctx, cls) => {
  // The three standup questions, as CQL over the panel's query.
  const [done, doing, stuck] = await Promise.all([
    rowsPanel(ctx, cls, orderedBy(andQuery(query, "completed >= sinceLastStandup()"), "completed DESC"), config.limit * 5),
    rowsPanel(ctx, cls, orderedBy(andQuery(query, "statusCategory = IN_PROGRESS"), "priority ASC, due ASC"), config.limit * 5),
    rowsPanel(ctx, cls, orderedBy(andQuery(query, "statusCategory NOT IN (DONE, CANCELLED) AND (blocked = true OR highlight IN (AMBER, RED))"), "priority ASC"), config.limit * 5),
  ]);
  const people = new Map<string, { id: string | null; name: string; done: PanelRow[]; inProgress: PanelRow[]; blocked: PanelRow[] }>();
  const add = (rows: PanelRow[], k: "done" | "inProgress" | "blocked") => {
    for (const r of rows) {
      const id = r.assignee?.id ?? null;
      const key = id ?? "__none__";
      if (!people.has(key)) people.set(key, { id, name: r.assignee?.name ?? "Unassigned", done: [], inProgress: [], blocked: [] });
      const p = people.get(key)!;
      if (p[k].length < config.limit) p[k].push(r);
    }
  };
  add(done.rows, "done");
  add(doing.rows, "inProgress");
  add(stuck.rows, "blocked");
  const all = [...done.rows, ...doing.rows, ...stuck.rows];
  return {
    data: { since: ctx.sinceLastStandup?.toISOString() ?? null, people: [...people.values()].sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name))) },
    meta: {
      total: (done.meta.total ?? 0) + (doing.meta.total ?? 0) + (stuck.meta.total ?? 0),
      truncated: done.meta.truncated || doing.meta.truncated || stuck.meta.truncated,
      classification: rowsClassification(cls, all),
    },
  };
};

const blockers: Compute<"blockers"> = async ({ query, config }, ctx, cls) => {
  const { rows, meta } = await rowsPanel(ctx, cls, andQuery(query, "blocked = true AND statusCategory NOT IN (DONE, CANCELLED)"), config.limit);
  const ids = rows.map((r) => r.id);
  const links = ids.length
    ? await prisma.workItemLink.findMany({
        where: {
          orgId: ctx.auth.orgId,
          OR: [
            { type: "BLOCKED_BY", sourceItemId: { in: ids } },
            { type: "BLOCKS", targetItemId: { in: ids } },
          ],
        },
        select: {
          type: true, createdAt: true, sourceItemId: true, targetItemId: true,
          sourceItem: { select: { id: true, ticketNumber: true, title: true, projectId: true } },
          targetItem: { select: { id: true, ticketNumber: true, title: true, projectId: true } },
        },
      })
    : [];
  // The blocker can sit in a project the viewer can't open: then it is named
  // as restricted, never by its key or title.
  const readable = new Set(await getReadableProjectIds(ctx.auth));
  const keys = new Map(
    (await prisma.project.findMany({ where: { id: { in: [...readable] }, orgId: ctx.auth.orgId }, select: { id: true, key: true } })).map((p) => [p.id, p.key]),
  );
  const byVictim = new Map<string, { key: string; title: string; since: string }[]>();
  for (const l of links) {
    const victim = l.type === "BLOCKED_BY" ? l.sourceItemId : l.targetItemId;
    const blocker = l.type === "BLOCKED_BY" ? l.targetItem : l.sourceItem;
    const visible = readable.has(blocker.projectId);
    const entry = {
      key: visible ? `${keys.get(blocker.projectId)}-${blocker.ticketNumber}` : RESTRICTED,
      title: visible ? (cls.applies && cls.resolver.restricted(blocker.projectId, blocker.title) ? RESTRICTED : blocker.title) : RESTRICTED,
      since: l.createdAt.toISOString(),
    };
    byVictim.set(victim, [...(byVictim.get(victim) ?? []), entry]);
  }
  const now = ctx.now.getTime();
  const out = rows
    .map((r) => {
      const by = byVictim.get(r.id) ?? [];
      const oldest = by.reduce((m, b) => Math.min(m, Date.parse(b.since)), now);
      return { ...r, blockedBy: by, daysBlocked: Math.max(0, Math.floor((now - oldest) / MS_DAY)) };
    })
    .sort((a, b) => b.daysBlocked - a.daysBlocked);
  return { data: { rows: out }, meta };
};

const agingWip: Compute<"aging-wip"> = async ({ query, config }, ctx, cls) => {
  const { rows, meta } = await rowsPanel(ctx, cls, orderedBy(andQuery(query, "statusCategory = IN_PROGRESS"), "statusChanged ASC"), config.limit);
  const entered = await prisma.workItem.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, columnEnteredAt: true, updatedAt: true } });
  const at = new Map(entered.map((e) => [e.id, e.columnEnteredAt ?? e.updatedAt]));
  const out = rows.map((r) => {
    const days = workingDaysBetween(at.get(r.id) ?? ctx.now, ctx.now);
    return { ...r, ageDays: days, tone: days >= config.dangerDays ? "danger" : days >= config.warnDays ? "warning" : "neutral" };
  });
  return { data: { rows: out, warnDays: config.warnDays, dangerDays: config.dangerDays }, meta };
};

const dueSoon: Compute<"due-soon"> = async ({ query, config }, ctx, cls) => {
  const q = orderedBy(andQuery(query, `due <= ${config.days}wd AND statusCategory NOT IN (DONE, CANCELLED)`), "due ASC, priority ASC");
  const { rows, meta } = await rowsPanel(ctx, cls, q, config.limit);
  const today = new Date(ctx.now.getTime()).toISOString().slice(0, 10);
  return { data: { rows: rows.map((r) => ({ ...r, overdue: !!r.due && r.due.slice(0, 10) < today })) }, meta };
};

const myWork: Compute<"my-work"> = async ({ query, config }, ctx, cls) => {
  const clause = config.mode === "watching" ? "watcher = me" : "assignee = me AND statusCategory NOT IN (DONE, CANCELLED)";
  const { rows, meta } = await rowsPanel(ctx, cls, orderedBy(andQuery(query, clause), "priority ASC, due ASC"), config.limit);
  return { data: { rows }, meta };
};

// ── Numbers ───────────────────────────────────────────────────────────────

const sumOf = (rows: AggRow[]) => rows.reduce((s, r) => s + r.value, 0);

const THRESHOLD = { ">": (a: number, b: number) => a > b, ">=": (a: number, b: number) => a >= b, "<": (a: number, b: number) => a < b, "<=": (a: number, b: number) => a <= b, "=": (a: number, b: number) => a === b };

async function measureOf(ctx: PanelRunContext, q: CqlQuery, measure: AggMeasure): Promise<{ value: number; total: number }> {
  const r = await aggregate(ctx, q, [], measure);
  return { value: r.rows.length ? sumOf(r.rows) : 0, total: r.total };
}

const number: Compute<"number"> = async ({ query, config }, ctx, cls) => {
  const now = await measureOf(ctx, query, m(config.measure));
  // "vs 7 days ago": the same query over what had been created by then.
  const before = config.compare ? await measureOf(ctx, andQuery(query, `created <= -${config.compare}`), m(config.measure)) : null;
  const tone = config.thresholds.find((t) => THRESHOLD[t.op](now.value, t.value))?.tone ?? "neutral";
  return {
    data: { value: now.value, tone, previous: before?.value ?? null, delta: before ? now.value - before.value : null },
    meta: { total: now.total, truncated: false, classification: projectsClassification(cls, await chartProjects(ctx)) },
  };
};

const kpiRow: Compute<"kpi-row"> = async ({ query, config }, ctx, cls) => {
  const items = await Promise.all(
    config.items.map(async (it) => {
      const sub = it.cql.trim() ? andQuery(query, it.cql) : query;
      const got = await measureOf(ctx, sub, m(it.measure));
      return { label: it.label, value: got.value, cql: it.cql };
    }),
  );
  return { data: { items }, meta: { total: null, truncated: false, classification: projectsClassification(cls, await chartProjects(ctx)) } };
};

const progress: Compute<"progress"> = async ({ query, config }, ctx, cls) => {
  const measure: AggMeasure = config.unit === "points" ? { fn: "sum", field: { kind: "sys", id: "points" } } : { fn: "count" };
  const r = await aggregate(ctx, query, [{ field: { kind: "sys", id: "statusCategory" } }], measure);
  const by = Object.fromEntries(r.rows.map((x) => [x.keys[0].id ?? "NONE", x.value]));
  const total = sumOf(r.rows);
  const done = by.DONE ?? 0;
  return {
    data: { unit: config.unit, total, done, percent: total > 0 ? Math.round((done / total) * 100) : 0, byCategory: by },
    meta: { total: r.total, truncated: false, classification: projectsClassification(cls, await chartProjects(ctx)), cql: r.cql },
  };
};

// ── Charts ────────────────────────────────────────────────────────────────

const series = (rows: AggRow[]) => rows.map((r) => ({ keys: r.keys, value: r.value, count: r.count, other: r.keys.some((k) => k.id === OTHER_ID) }));

const breakdown: Compute<"breakdown"> = async ({ query, config }, ctx, cls) => {
  const r = await aggregate(ctx, query, [{ field: fr(config.field), limit: config.limit }], m(config.measure));
  return {
    data: { chart: config.chart, rows: series(r.rows) },
    meta: { total: r.total, truncated: r.truncated, classification: projectsClassification(cls, await chartProjects(ctx)), cql: r.cql },
  };
};

const stacked: Compute<"stacked"> = async ({ query, config }, ctx, cls) => {
  const r = await aggregate(ctx, query, [{ field: fr(config.x), ...(config.bucket ? { bucket: config.bucket } : {}) }, { field: fr(config.y) }], m(config.measure));
  return {
    data: { orientation: config.orientation, rows: series(r.rows) },
    meta: { total: r.total, truncated: r.truncated, classification: projectsClassification(cls, await chartProjects(ctx)), cql: r.cql },
  };
};

const matrix: Compute<"matrix"> = async ({ query, config }, ctx, cls) => {
  const r = await aggregate(ctx, query, [{ field: fr(config.x) }, { field: fr(config.y) }], m(config.measure));
  const xs = new Map<string, string>();
  const ys = new Map<string, string>();
  const cells: Record<string, number> = {};
  for (const row of r.rows) {
    const [x, y] = row.keys;
    const xk = x.id ?? "";
    const yk = y.id ?? "";
    xs.set(xk, x.label);
    ys.set(yk, y.label);
    cells[`${xk}\u0000${yk}`] = row.value;
  }
  const colTotals = [...xs.keys()].map((x) => [...ys.keys()].reduce((s, y) => s + (cells[`${x}\u0000${y}`] ?? 0), 0));
  const rowTotals = [...ys.keys()].map((y) => [...xs.keys()].reduce((s, x) => s + (cells[`${x}\u0000${y}`] ?? 0), 0));
  return {
    data: {
      x: [...xs].map(([id, label]) => ({ id: id || null, label })),
      y: [...ys].map(([id, label]) => ({ id: id || null, label })),
      cells: [...ys.keys()].map((y) => [...xs.keys()].map((x) => cells[`${x}\u0000${y}`] ?? 0)),
      colTotals,
      rowTotals,
      total: sumOf(r.rows),
    },
    meta: { total: r.total, truncated: r.truncated, classification: projectsClassification(cls, await chartProjects(ctx)), cql: r.cql },
  };
};

const createdVsResolved: Compute<"created-vs-resolved"> = async ({ query, config }, ctx, cls) => {
  const [created, resolved] = await Promise.all([
    aggregate(ctx, andQuery(query, `created >= ${config.window}`), [{ field: { kind: "sys", id: "created" }, bucket: config.bucket }], { fn: "count" }),
    aggregate(ctx, andQuery(query, `completed >= ${config.window}`), [{ field: { kind: "sys", id: "completed" }, bucket: config.bucket }], { fn: "count" }),
  ]);
  const buckets = [...new Set([...created.rows, ...resolved.rows].map((r) => r.keys[0].id).filter((x): x is string => !!x))].sort();
  const c = new Map(created.rows.map((r) => [r.keys[0].id, r.value]));
  const d = new Map(resolved.rows.map((r) => [r.keys[0].id, r.value]));
  let cc = 0;
  let dd = 0;
  const points = buckets.map((b) => {
    cc = config.cumulative ? cc + (c.get(b) ?? 0) : (c.get(b) ?? 0);
    dd = config.cumulative ? dd + (d.get(b) ?? 0) : (d.get(b) ?? 0);
    return { bucket: b, created: cc, resolved: dd };
  });
  return {
    data: { bucket: config.bucket, cumulative: config.cumulative, points },
    meta: { total: created.total, truncated: false, classification: projectsClassification(cls, await chartProjects(ctx)) },
  };
};

const workload: Compute<"workload"> = async ({ query, config }, ctx, cls) => {
  const measure: AggMeasure = config.unit === "points" ? { fn: "sum", field: { kind: "sys", id: "points" } } : { fn: "count" };
  const r = await aggregate(ctx, andQuery(query, "statusCategory NOT IN (DONE, CANCELLED)"), [{ field: { kind: "sys", id: "assignee" }, limit: 25 }], measure);
  return {
    data: { unit: config.unit, rows: series(r.rows).sort((a, b) => b.value - a.value) },
    meta: { total: r.total, truncated: r.truncated, classification: projectsClassification(cls, await chartProjects(ctx)), cql: r.cql },
  };
};

// ── Context ───────────────────────────────────────────────────────────────

const markdown: Compute<"markdown"> = async ({ config }, _ctx, cls) => ({
  data: { content: config.content },
  // Free text a person typed: the marking tripwire still applies.
  meta: { total: null, truncated: false, classification: cls.applies ? { level: cls.resolver.rowLevel(null, config.content), markedRows: 0 } : undefined },
});

const CHANGE_FIELDS = { status: "columnKey", assignee: "assigneeId", priority: "priority" } as const;

/** Recorded changes to the items a query matches, newest first. */
async function changesFor(ctx: PanelRunContext, cls: Classifier, q: CqlQuery, fields: string[] | null, since: Date | null, limit: number) {
  const ids = await matchingIds(ctx, q);
  if (ids.length === 0) return { items: [], total: 0 };
  const acts = await prisma.activity.findMany({
    where: {
      orgId: ctx.auth.orgId,
      workItemId: { in: ids },
      ...(fields ? { field: { in: fields } } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, workItemId: true, userId: true, action: true, field: true, oldValue: true, newValue: true, createdAt: true },
  });
  const itemIds = [...new Set(acts.map((a) => a.workItemId!).filter(Boolean))];
  const { rows } = await listRows(ctx, { v: 1, where: { op: "in", field: { kind: "sys", id: "key" }, values: itemIds.map((id) => ({ t: "ref", entity: "item", id })) } }, Math.max(1, itemIds.length));
  const items = new Map((await toPanelRows(ctx, rows, cls)).map((r) => [r.id, r]));
  const userIds = [...new Set(acts.map((a) => a.userId))];
  const users = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
  const shown = acts
    .filter((a) => a.workItemId && items.has(a.workItemId))
    .map((a) => ({ id: a.id, at: a.createdAt.toISOString(), by: users.get(a.userId) ?? "Someone", action: a.action, field: a.field, from: a.oldValue, to: a.newValue, item: items.get(a.workItemId!)! }));
  return { items: shown, total: ids.length };
}

const changesSince: Compute<"changes-since"> = async ({ query, config }, ctx, cls) => {
  const since =
    config.since === "sinceLastStandup"
      ? (ctx.sinceLastStandup ?? new Date(ctx.now.getTime() - MS_DAY))
      : new Date(ctx.now.getTime() + relMs(config.since));
  const { items, total } = await changesFor(ctx, cls, query, config.fields.map((f) => CHANGE_FIELDS[f]), since, config.limit);
  return { data: { since: since.toISOString(), changes: items }, meta: { total, truncated: items.length >= config.limit, classification: rowsClassification(cls, items.map((c) => c.item)) } };
};

const activity: Compute<"activity"> = async ({ query, config }, ctx, cls) => {
  const { items, total } = await changesFor(ctx, cls, query, null, null, config.limit);
  return { data: { changes: items }, meta: { total, truncated: items.length >= config.limit, classification: rowsClassification(cls, items.map((c) => c.item)) } };
};

export const COMPUTES: { [T in PanelType]: Compute<T> } = {
  "item-list": itemList,
  "standup-walk": standupWalk,
  "changes-since": changesSince,
  blockers,
  "aging-wip": agingWip,
  "due-soon": dueSoon,
  "my-work": myWork,
  number,
  "kpi-row": kpiRow,
  progress,
  breakdown,
  stacked,
  matrix,
  "created-vs-resolved": createdVsResolved,
  workload,
  markdown,
  activity,
  ...FLOW_COMPUTES,
};

