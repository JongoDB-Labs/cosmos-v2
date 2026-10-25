/**
 * What every panel compute shares: the viewer, the clock, the dashboard's
 * variables, and the one way panels read work items: through the CQL
 * executor (`executeCql`, `aggregateCql`, `idsCql`), which applies the
 * viewer's readable projects itself. A compute never builds its own
 * work-item where; it composes CQL and lets the executor scope it.
 *
 * Rows leave with display names resolved here (status column names, sprint
 * names) and, for tenants classification applies to, a per-row level and
 * marking (`classification/resolver.ts`, the calendar feed's rule). For
 * COMMERCIAL tenants the field is omitted, never shown as "Unclassified".
 */
import { prisma } from "@/lib/db/client";
import type { ClassificationLevel } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { executeCql, idsCql, type CqlRunOptions } from "@/lib/query/execute.server";
import type { VarInput } from "@/lib/query/resolve.server";
import { parseCql } from "@/lib/query/parser";
import { CQL_VERSION, type CqlNode, type CqlQuery } from "@/lib/query/ast";
import type { IssueRow } from "@/lib/work-items/query/project";
import { classificationApplies } from "@/lib/compliance/classification";
import type { PanelConfig, PanelType } from "./panel-registry";
import { createClassificationResolver, type ClassificationResolver } from "@/lib/classification/resolver";
import { rankOf } from "@/lib/classification/effective";

export interface PanelRunContext {
  auth: AuthContext;
  tz: string;
  now: Date;
  vars: Record<string, VarInput>;
  sinceLastStandup?: Date;
  contextProjectId?: string;
}

export interface RowClassification {
  level: ClassificationLevel;
  marked: boolean;
}

export interface PanelMeta {
  /** Items the panel's query matched (null when counting ran out of time). */
  total: number | null;
  /** Something was capped: a list's rows, groups folded into "Other". */
  truncated: boolean;
  generatedAt: string;
  /** The highest level among the data shown (omitted where classification doesn't apply). */
  classification?: { level: ClassificationLevel; markedRows: number };
  /** The canonical CQL the panel ran, for "Open in Issues". */
  cql?: string;
}

/** A work item as list panels return it. */
export interface PanelRow {
  id: string;
  key: string;
  title: string;
  projectId: string;
  type: string;
  status: string;
  statusKey: string;
  assignee: { id: string; name: string } | null;
  priority: string;
  due: string | null;
  sprint: { id: string; name: string } | null;
  points: number | null;
  labels: string[];
  updated: string;
  classification?: RowClassification;
}

/** The query with more clauses ANDed on (each given as CQL text or a node). */
export function andQuery(q: CqlQuery, ...more: (string | CqlNode | null)[]): CqlQuery {
  const parts: CqlNode[] = [];
  if (q.where) parts.push(q.where);
  for (const m of more) {
    if (!m) continue;
    const node = typeof m === "string" ? parseCql(m).query.where : m;
    if (node) parts.push(node);
  }
  const where = parts.length === 0 ? null : parts.length === 1 ? parts[0] : ({ op: "and", args: parts } as CqlNode);
  return { ...q, v: CQL_VERSION, where };
}

/** With a different ORDER BY (CQL text, e.g. "due ASC, priority ASC"). */
export function orderedBy(q: CqlQuery, orderBy: string): CqlQuery {
  const parsed = parseCql(`ORDER BY ${orderBy}`).query;
  return { ...q, orderBy: parsed.orderBy };
}

export function runOptions(ctx: PanelRunContext, extra: Partial<CqlRunOptions> = {}): CqlRunOptions {
  return {
    tz: ctx.tz,
    now: ctx.now,
    vars: ctx.vars,
    ...(ctx.contextProjectId ? { contextProjectId: ctx.contextProjectId } : {}),
    ...(ctx.sinceLastStandup ? { sinceLastStandup: ctx.sinceLastStandup } : {}),
    timeoutMs: 5_000,
    ...extra,
  };
}

/** Rows for a query, as the viewer, plus the total. */
export async function listRows(ctx: PanelRunContext, q: CqlQuery, limit: number) {
  const r = await executeCql(ctx.auth, { query: q }, runOptions(ctx, { pageSize: limit }));
  return { rows: r.data, total: r.total, cql: r.cql };
}

/** Ids for a query, as the viewer (at most IDS_ONLY_MAX; past that the executor refuses). */
export async function matchingIds(ctx: PanelRunContext, q: CqlQuery): Promise<string[]> {
  return (await idsCql(ctx.auth, { query: q }, runOptions(ctx))).ids;
}

/** Status column names and sprint names for rows, in two queries. */
async function names(orgId: string, rows: IssueRow[]) {
  const projectIds = [...new Set(rows.map((r) => r.project.id))];
  const intervalIds = [...new Set(rows.map((r) => r.intervalId).filter((x): x is string => !!x))];
  const [columns, intervals] = await Promise.all([
    projectIds.length
      ? prisma.boardColumn.findMany({
          where: { board: { orgId, projectId: { in: projectIds } } },
          select: { key: true, name: true, sortOrder: true, board: { select: { projectId: true } } },
          orderBy: { sortOrder: "asc" },
        })
      : [],
    intervalIds.length ? prisma.interval.findMany({ where: { id: { in: intervalIds } }, select: { id: true, name: true } }) : [],
  ]);
  const status = new Map<string, string>();
  for (const c of columns) {
    const k = `${c.board.projectId}:${c.key}`;
    if (!status.has(k)) status.set(k, c.name);
  }
  return { status, sprint: new Map(intervals.map((i) => [i.id, i.name])) };
}

export interface Classifier {
  applies: boolean;
  resolver: ClassificationResolver;
}

/** The org's classification rules, loaded once per request. */
export async function loadClassifier(orgId: string): Promise<Classifier> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { tenantClass: true } });
  const applies = !!org && classificationApplies(org.tenantClass);
  return { applies, resolver: await createClassificationResolver(orgId) };
}

export async function toPanelRows(ctx: PanelRunContext, rows: IssueRow[], cls: Classifier): Promise<PanelRow[]> {
  const n = await names(ctx.auth.orgId, rows);
  return rows.map((r) => ({
    id: r.id,
    key: r.ticketKey,
    title: r.title,
    projectId: r.project.id,
    type: r.type.name,
    status: n.status.get(`${r.project.id}:${r.columnKey}`) ?? r.columnKey,
    statusKey: r.columnKey,
    assignee: r.assignee ? { id: r.assignee.id, name: r.assignee.displayName } : null,
    priority: r.priority,
    due: r.dueDate,
    sprint: r.intervalId ? { id: r.intervalId, name: n.sprint.get(r.intervalId) ?? "" } : null,
    points: r.storyPoints,
    labels: r.tags,
    updated: r.updatedAt,
    ...(cls.applies
      ? { classification: { level: cls.resolver.rowLevel(r.project.id, r.title), marked: cls.resolver.restricted(r.project.id, r.title) } }
      : {}),
  }));
}

/** The highest level among rows, and how many are marked; never below the org's own level. */
export function rowsClassification(cls: Classifier, rows: { classification?: RowClassification }[]): PanelMeta["classification"] {
  if (!cls.applies) return undefined;
  let level = cls.resolver.orgLevel;
  let markedRows = 0;
  for (const r of rows) {
    if (!r.classification) continue;
    if (rankOf(r.classification.level) > rankOf(level)) level = r.classification.level;
    if (r.classification.marked) markedRows++;
  }
  return { level, markedRows };
}

/**
 * For numbers and charts, which show no rows: the highest level among the
 * projects the viewer's query could have counted. It can over-state, never
 * under-state; a chart over a CUI project carries CUI.
 */
export function projectsClassification(cls: Classifier, projectIds: Iterable<string>): PanelMeta["classification"] {
  if (!cls.applies) return undefined;
  let level = cls.resolver.orgLevel;
  for (const p of projectIds) {
    const l = cls.resolver.levelFor(p);
    if (rankOf(l) > rankOf(level)) level = l;
  }
  return { level, markedRows: 0 };
}

export interface ComputeInput<T extends PanelType> {
  query: CqlQuery;
  config: PanelConfig<T>;
}
export interface ComputeOutput {
  data: unknown;
  meta: Omit<PanelMeta, "generatedAt">;
}
export type Compute<T extends PanelType> = (input: ComputeInput<T>, ctx: PanelRunContext, cls: Classifier) => Promise<ComputeOutput>;


const MS_DAY = 86_400_000;

/** Weekdays between two instants (Mon–Fri), whole days, never negative. */
export function workingDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let n = 0;
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (d.getTime() < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

/** `-7d` / `-2w` / `-1M` / `-5wd` as milliseconds (working days as calendar days × 7/5, rounded up). */
export function relMs(rel: string): number {
  const m = /^-(\d+)(wd|d|w|M)$/.exec(rel);
  if (!m) return -30 * MS_DAY;
  const n = Number(m[1]);
  const days = m[2] === "d" ? n : m[2] === "w" ? n * 7 : m[2] === "M" ? n * 30 : Math.ceil((n * 7) / 5);
  return -days * MS_DAY;
}

