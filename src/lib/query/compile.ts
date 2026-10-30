/**
 * Resolved CqlQuery → Prisma where/orderBy. PURE: everything that needs the
 * database (which sprints are open, which columns are "done", what a variable
 * holds) was looked up by resolve.server.ts and arrives in `CompileEnv`.
 *
 * The output is the USER predicate only. It never mentions orgId and never
 * widens project scope: execute.server.ts places it inside `buildScopedWhere`'s
 * envelope, and a test walks generated trees to prove orgId never appears here.
 * Only execute.server.ts may import this module (arch test).
 *
 * Semantics worth knowing:
 *   - `!=` and `NOT IN` do not match items where the field is empty (Jira's
 *     rule); the typechecker warns and offers `OR f IS EMPTY`.
 *   - A clause whose value is an UNSET dashboard variable is inert (matches
 *     everything): "Person: everyone" narrows nothing.
 *   - `assignee` matches the primary assignee or any co-assignee.
 *   - `statusCategory = DONE` is "done column OR has a completion date", the
 *     same OR that lib/work-items/done-state.ts uses.
 *   - History (`WAS`, `CHANGED`) reads the Activity rows the writers record:
 *     `f WAS v` is "is v now, or a recorded change left or entered v";
 *     with AFTER / BEFORE / ON / DURING it is "held v at some instant in that
 *     window", whose "held it when the window opened" part is an id prefilter
 *     (history.server.ts, results in `env.history`). `BY u` means u made the
 *     change to v. `CHANGED` is a relation filter on Activity.
 */
import { Prisma } from "@prisma/client";
import {
  mentionsField,
  predValues,
  type CmpOp,
  type CqlNode,
  type CqlQuery,
  type CqlSort,
  type CqlValue,
  type FieldRef,
  type HistoryPreds,
  type LeafNode,
} from "./ast";
import { PRIORITY_ORDER, type SystemFieldId } from "./fields";
import { applyRel, dayOf, durationSeconds, endOf, literalRange, periodOffset, startOf, workingDaysFrom, type Period } from "./dates";
import { HISTORY_BY_FIELD, fnKey, varKey, type CompileEnv, type SqlSortKey, type StatusCategory } from "./env";
import { HISTORY, historyKey, isHistoryColumn, type HistoryField, type HistorySpec, type HistoryValueSet } from "./history";
import type { CustomFieldType } from "./typecheck";

type Where = Prisma.WorkItemWhereInput;

export interface Compiled {
  where: Where;
  archived: "active" | "only" | "all";
  orderBy: Prisma.WorkItemOrderByWithRelationInput[];
  /**
   * Set when the ORDER BY names something Prisma can't sort by (assignee's
   * name, status name, project key, a custom field): the whole ordering then
   * runs as SQL over the matching ids (sort.server.ts). `orderBy` is unused.
   */
  sqlSort: SqlSortKey[] | null;
}

/** Sort keys only the SQL path can order by. */
const SQL_ONLY_SORT = new Set<string>(["assignee", "status", "project"]);

export const TRUE: Where = {};
export const FALSE: Where = { id: { in: [] } };

const and = (...w: Where[]): Where => {
  const parts = w.filter((x) => Object.keys(x).length > 0);
  return parts.length === 0 ? TRUE : parts.length === 1 ? parts[0] : { AND: parts };
};
const or = (...w: Where[]): Where => (w.length === 0 ? FALSE : w.length === 1 ? w[0] : { OR: w });
const not = (w: Where): Where => ({ NOT: w });

/**
 * A filter on a NULLABLE column, made two-valued. In SQL `NOT (col IN (…))` is
 * NULL, not true, when col is NULL, so negating a plain filter silently drops
 * every row where the column is empty: `assignee != me` lost items whose only
 * assignees were co-assignees. Carrying `not: null` inside the filter makes its
 * NOT a true complement.
 */
const nn = (column: string, filter: Record<string, unknown>): Where => ({ [column]: { ...filter, not: null } }) as Where;

/** One concrete value after functions and variables are expanded. */
type Bound =
  | { k: "id"; id: string }
  | { k: "empty" }
  | { k: "scalar"; v: string | number | boolean }
  /** An instant, or for a date literal / `=` the whole day. */
  | { k: "time"; from: Date; to: Date; day: boolean }
  | { k: "where"; where: Where };

class Inert extends Error {}

function timeOf(v: CqlValue, env: CompileEnv): Bound {
  switch (v.t) {
    case "date": {
      const r = literalRange(v.v, env.tz);
      return { k: "time", ...r, day: /^\d{4}-\d{2}-\d{2}$/.test(v.v) };
    }
    case "rel": {
      const at = applyRel(v.v, env.now, env.tz);
      return { k: "time", from: at, to: new Date(at.getTime() + 1), day: false };
    }
    case "fn": {
      const at = fnInstant(v, env);
      return { k: "time", from: at, to: new Date(at.getTime() + 1), day: false };
    }
    default:
      throw new Error(`Not a time value: ${v.t}`);
  }
}

function fnInstant(v: Extract<CqlValue, { t: "fn" }>, env: CompileEnv): Date {
  const arg = v.args[0] as { t: "rel"; v: string } | { t: "num"; v: number } | undefined;
  const period = (name: string): Period => name.replace(/^(startOf|endOf)/, "").toLowerCase() as Period;
  switch (v.name) {
    case "now":
      return env.now;
    case "startOfDay":
    case "startOfWeek":
    case "startOfMonth":
    case "startOfYear":
      return startOf(period(v.name), env.now, env.tz, periodOffset(period(v.name), arg));
    case "endOfDay":
    case "endOfWeek":
    case "endOfMonth":
    case "endOfYear":
      return endOf(period(v.name), env.now, env.tz, periodOffset(period(v.name), arg));
    case "sinceLastStandup":
      return env.sinceLastStandup ?? workingDaysFrom(env.now, env.tz, -1);
    default:
      throw new Error(`${v.name}() is not a date`);
  }
}

/** Item-set functions as predicates on the item itself. */
function itemFnWhere(v: Extract<CqlValue, { t: "fn" }>, env: CompileEnv): Where | null {
  const refId = (x: CqlValue | undefined) => (x && x.t === "ref" ? x.id : null);
  switch (v.name) {
    case "watchedItems":
      return { watchers: { some: { userId: env.actorUserId } } };
    case "childrenOf": {
      const id = refId(v.args[0]);
      return id ? { parentId: id } : FALSE;
    }
    case "descendantsOf": {
      const id = refId(v.args[0]);
      return id ? { id: { in: env.descendants.get(id) ?? [] } } : FALSE;
    }
    case "linkedItems": {
      const id = refId(v.args[0]);
      if (!id) return FALSE;
      const typeArg = v.args[1];
      const type = typeArg && typeArg.t === "str" ? (typeArg.v.toUpperCase() as Prisma.EnumLinkTypeFilter["equals"]) : undefined;
      return or(
        { outgoingLinks: { some: { targetItemId: id, ...(type ? { type } : {}) } } },
        { incomingLinks: { some: { sourceItemId: id, ...(type ? { type } : {}) } } },
      );
    }
    case "updatedBy": {
      const userId = v.args[0]?.t === "ref" ? v.args[0].id : v.args[0]?.t === "fn" ? env.actorUserId : null;
      if (!userId) return FALSE;
      const from = v.args[1] ? (timeOf(v.args[1], env) as Extract<Bound, { k: "time" }>).from : undefined;
      const to = v.args[2] ? (timeOf(v.args[2], env) as Extract<Bound, { k: "time" }>).to : undefined;
      return {
        activities: {
          some: {
            userId,
            ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
          },
        },
      };
    }
    default:
      return null;
  }
}

const DURATION_FIELDS = new Set<string>(["originalEstimate", "remainingEstimate", "timeSpent"]);

/** Expand a leaf's values: functions to ids, variables to their values. */
function bind(values: CqlValue[], field: FieldRef, env: CompileEnv): Bound[] {
  const duration = field.kind === "sys" && DURATION_FIELDS.has(field.id);
  const out: Bound[] = [];
  for (const v of values) {
    switch (v.t) {
      case "var": {
        const val = env.vars.get(varKey(v.name, field));
        if (val == null) throw new Inert();
        out.push(...bind(val, field, env));
        break;
      }
      case "ref":
        out.push({ k: "id", id: v.id });
        break;
      case "empty":
        out.push({ k: "empty" });
        break;
      case "fn": {
        if (v.name === "currentUser") {
          out.push({ k: "id", id: env.actorUserId });
          break;
        }
        if (v.name === "currentProject") {
          out.push(env.contextProjectId ? { k: "id", id: env.contextProjectId } : { k: "where", where: FALSE });
          break;
        }
        const itemWhere = itemFnWhere(v, env);
        if (itemWhere) {
          out.push({ k: "where", where: itemWhere });
          break;
        }
        const ids = env.fnIds.get(fnKey(v));
        if (ids) {
          out.push(...ids.map((id) => ({ k: "id" as const, id })));
          break;
        }
        out.push(timeOf(v, env));
        break;
      }
      case "rel":
        // `2h` on an estimate is an amount of time, not a moment.
        out.push(duration ? { k: "scalar", v: v.v } : timeOf(v, env));
        break;
      case "date":
        out.push(timeOf(v, env));
        break;
      case "str":
      case "num":
      case "bool":
        out.push({ k: "scalar", v: v.v });
        break;
    }
  }
  return out;
}

const ids = (b: Bound[]) => b.filter((x): x is Extract<Bound, { k: "id" }> => x.k === "id").map((x) => x.id);
const scalars = (b: Bound[]) => b.filter((x): x is Extract<Bound, { k: "scalar" }> => x.k === "scalar").map((x) => x.v);
const wheres = (b: Bound[]) => b.filter((x): x is Extract<Bound, { k: "where" }> => x.k === "where").map((x) => x.where);
const hasEmpty = (b: Bound[]) => b.some((x) => x.k === "empty");

/**
 * How a field matches a set of values, and what "empty" means for it. `match`
 * gets the non-empty values; `isEmpty` is null for fields that are never empty.
 */
interface FieldCompiler {
  match(b: Bound[]): Where;
  isEmpty: Where | null;
  /** `<` / `>` etc., for ordered fields. */
  order?(cmp: Exclude<CmpOp, "eq" | "neq">, b: Bound): Where;
  /** `IN ALL`, for multi-valued fields. */
  matchAll?(b: Bound[]): Where;
  /** `~`. */
  text?(q: string): Where;
}

/**
 * The text of a `~` search as a LIKE operand. Prisma's contains/startsWith do
 * NOT escape LIKE wildcards: unescaped, `summary ~ "%"` matched every item and
 * `_` matched any character. Postgres' default LIKE escape is backslash.
 */
export function likeText(q: string): string {
  return q.replace(/\*$/, "").replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Same caveat as `stringCompiler`: this union is hand-written and the body
 *  casts through `as Where`, so these names are verified against
 *  `model WorkItem` by hand, not by the compiler. */
function contains(
  column:
    | "title"
    | "description"
    | "resolution"
    | "externalKey"
    | "externalSource"
    | "externalId"
    | "sourceStatus"
    | "cancelNote",
  q: string,
): Where {
  const prefix = q.endsWith("*") && column === "title";
  const value = likeText(q);
  return { [column]: prefix ? { startsWith: value, mode: "insensitive" } : { contains: value, mode: "insensitive" } } as Where;
}

function timeCompiler(column: keyof Where & string, nullable: boolean, tz: string): FieldCompiler {
  const col = (filter: Prisma.DateTimeNullableFilter): Where =>
    (nullable ? nn(column, filter as Record<string, unknown>) : ({ [column]: filter } as Where));
  return {
    match: (b) =>
      or(
        ...b
          .filter((x): x is Extract<Bound, { k: "time" }> => x.k === "time")
          // `=` means "on that day", for a literal date or an offset alike.
          .map((t) => (t.day ? t : { ...t, ...dayOf(t.from, tz) }))
          .map((t) => col({ gte: t.from, lt: t.to, ...(nullable ? { not: null } : {}) })),
      ),
    // Plain `null`: through `col` it would carry `not: null` too and match nothing.
    isEmpty: nullable ? ({ [column]: null } as Where) : null,
    order: (cmp, x) => {
      const t = x as Extract<Bound, { k: "time" }>;
      // For a whole day, `<` means before the day and `<=` means through it.
      switch (cmp) {
        case "lt":
          return col({ lt: t.from });
        case "lte":
          return col({ lt: t.day ? t.to : new Date(t.from.getTime() + 1) });
        case "gt":
          return col({ gte: t.day ? t.to : new Date(t.from.getTime() + 1) });
        case "gte":
          return col({ gte: t.from });
      }
    },
  };
}

function numberCompiler(column: "storyPoints" | "originalEstimate" | "remainingEstimate" | "timeSpent", duration: boolean): FieldCompiler {
  const num = (b: Bound): number => {
    if (b.k !== "scalar") throw new Error("number expected");
    if (duration && typeof b.v === "string") return durationSeconds(b.v) ?? NaN;
    return Number(b.v);
  };
  const col = (f: Prisma.IntNullableFilter): Where => nn(column, f as Record<string, unknown>);
  return {
    match: (b) => col({ in: scalars(b).map((v) => num({ k: "scalar", v })) }),
    isEmpty: { [column]: null } as Where,
    order: (cmp, b) => col({ [cmp]: num(b) }),
  };
}

function enumCompiler(column: "priority" | "workCategory" | "cancelReason" | "highlight", nullable: boolean): FieldCompiler {
  return {
    match: (b) =>
      nullable ? nn(column, { in: scalars(b).map(String) }) : ({ [column]: { in: scalars(b).map(String) } } as Where),
    isEmpty: nullable ? ({ [column]: null } as Where) : null,
    order:
      column === "priority"
        ? (cmp, b) => {
            const r = PRIORITY_ORDER.indexOf(String((b as { v: string }).v) as (typeof PRIORITY_ORDER)[number]);
            const keep = PRIORITY_ORDER.filter((_, i) =>
              cmp === "lt" ? i < r : cmp === "lte" ? i <= r : cmp === "gt" ? i > r : i >= r,
            );
            return { priority: { in: [...keep] } };
          }
        : undefined,
  };
}

/**
 * A plain nullable string column, matched case-insensitively.
 *
 * The union is hand-written and the bodies cast through `as Where`, so
 * TypeScript does NOT check these names against Prisma — an invalid column here
 * is a runtime 500 with a green type-check. Every name below was verified
 * against `model WorkItem` in prisma/schema.prisma by hand.
 */
function stringCompiler(
  column:
    | "resolution"
    | "externalKey"
    | "externalSource"
    | "externalId"
    | "sourceStatus"
    | "cancelNote",
): FieldCompiler {
  return {
    match: (b) => or(...scalars(b).map((v) => nn(column, { equals: String(v), mode: "insensitive" }))),
    isEmpty: or({ [column]: null } as Where, { [column]: "" } as Where),
    text: (q) => and(nn(column, {}), contains(column, q)),
  };
}

function statusCategoryWhere(cat: StatusCategory, env: CompileEnv): Where {
  const inColumns = or(
    ...env.statusCategories[cat]
      .filter((p) => p.keys.length > 0)
      .map((p) => ({ projectId: p.projectId, columnKey: { in: p.keys } })),
  );
  // DONE is "in a done lane OR finished", like isWorkItemDone. The others
  // exclude finished work so an item is in exactly one category.
  if (cat === "DONE") return or(inColumns, { completedAt: { not: null } });
  if (cat === "CANCELLED") return inColumns;
  return and(inColumns, { completedAt: null });
}

function sysCompiler(id: SystemFieldId, env: CompileEnv): FieldCompiler {
  switch (id) {
    case "project":
      return { match: (b) => ({ projectId: { in: ids(b) } }), isEmpty: null };
    case "key":
      return {
        match: (b) => or(...(ids(b).length ? [{ id: { in: ids(b) } }] : []), ...wheres(b)),
        isEmpty: null,
        order: (cmp, b) => {
          const item = b.k === "id" ? env.items.get(b.id) : undefined;
          if (!item) return FALSE;
          return { projectId: item.projectId, ticketNumber: { [cmp]: item.ticketNumber } };
        },
      };
    case "type":
      return { match: (b) => ({ workItemTypeId: { in: ids(b) } }), isEmpty: null };
    case "status":
      return { match: (b) => ({ columnKey: { in: ids(b) } }), isEmpty: null };
    case "statusCategory":
      return {
        match: (b) => or(...scalars(b).map((c) => statusCategoryWhere(c as StatusCategory, env))),
        isEmpty: null,
      };
    case "priority":
      return enumCompiler("priority", false);
    case "assignee":
      return {
        match: (b) => {
          const u = ids(b);
          return or(nn("assigneeId", { in: u }), { assignees: { some: { userId: { in: u } } } });
        },
        isEmpty: { assigneeId: null, assignees: { none: {} } },
      };
    case "primaryAssignee":
      return { match: (b) => nn("assigneeId", { in: ids(b) }), isEmpty: { assigneeId: null } };
    case "reporter":
      return { match: (b) => ({ createdById: { in: ids(b) } }), isEmpty: null };
    case "watcher":
      return { match: (b) => ({ watchers: { some: { userId: { in: ids(b) } } } }), isEmpty: { watchers: { none: {} } } };
    case "label":
      return {
        match: (b) => ({ labels: { some: { labelId: { in: ids(b) } } } }),
        matchAll: (b) => and(...ids(b).map((labelId) => ({ labels: { some: { labelId } } }))),
        isEmpty: { labels: { none: {} } },
      };
    case "sprint":
      return { match: (b) => nn("intervalId", { in: ids(b) }), isEmpty: { intervalId: null } };
    case "intervalKind":
      return {
        match: (b) =>
          and(nn("intervalId", {}), {
            interval: { is: { intervalKind: { in: scalars(b).map(String) as Prisma.EnumIntervalKindFilter["in"] } } },
          }),
        isEmpty: null,
      };
    case "pi":
      return {
        match: (b) => and(nn("intervalId", {}), or({ intervalId: { in: ids(b) } }, { interval: { is: { parentId: { in: ids(b) } } } })),
        isEmpty: null,
      };
    case "team":
      return { match: (b) => nn("teamId", { in: ids(b) }), isEmpty: { teamId: null } };
    case "parent":
      return { match: (b) => nn("parentId", { in: ids(b) }), isEmpty: { parentId: null } };
    case "blocked": {
      const blocked: Where = or(
        { incomingLinks: { some: { type: "BLOCKS" } } },
        { outgoingLinks: { some: { type: "BLOCKED_BY" } } },
      );
      return {
        match: (b) => or(...scalars(b).map((v) => (v === true ? blocked : not(blocked)))),
        isEmpty: null,
      };
    }
    case "linkedTo":
      return {
        match: (b) =>
          or(
            { outgoingLinks: { some: { targetItemId: { in: ids(b) } } } },
            { incomingLinks: { some: { sourceItemId: { in: ids(b) } } } },
          ),
        isEmpty: null,
      };
    case "points":
      return numberCompiler("storyPoints", false);
    case "originalEstimate":
    case "remainingEstimate":
    case "timeSpent":
      return numberCompiler(id, true);
    case "created":
      return timeCompiler("createdAt", false, env.tz);
    case "updated":
      return timeCompiler("updatedAt", false, env.tz);
    case "due":
      return timeCompiler("dueDate", true, env.tz);
    case "start":
      return timeCompiler("startDate", true, env.tz);
    case "actualStart":
      return timeCompiler("actualStart", true, env.tz);
    case "completed":
      return timeCompiler("completedAt", true, env.tz);
    case "statusChanged":
      return timeCompiler("columnEnteredAt", true, env.tz);
    case "archivedAt":
      return timeCompiler("archivedAt", true, env.tz);
    case "archived":
      return {
        match: (b) => or(...scalars(b).map((v) => (v === true ? { archivedAt: { not: null } } : { archivedAt: null }))),
        isEmpty: null,
      };
    case "workCategory":
      return enumCompiler("workCategory", false);
    case "cancelReason":
      return enumCompiler("cancelReason", true);
    case "highlight":
      return enumCompiler("highlight", true);
    case "resolution":
    case "externalKey":
    case "externalSource":
    case "externalId":
    case "sourceStatus":
    case "cancelNote":
      return stringCompiler(id);
    case "summary":
      return { match: () => FALSE, isEmpty: null, text: (q) => contains("title", q) };
    case "description":
      return { match: () => FALSE, isEmpty: { description: "" }, text: (q) => contains("description", q) };
    case "comment":
      return {
        match: () => FALSE,
        isEmpty: null,
        text: (q) => ({ comments: { some: { content: { contains: likeText(q), mode: "insensitive" } } } }),
      };
    case "text":
      return {
        match: () => FALSE,
        isEmpty: null,
        text: (q) => {
          const value = likeText(q);
          return or(
            { title: { contains: value, mode: "insensitive" } },
            { description: { contains: value, mode: "insensitive" } },
            { comments: { some: { content: { contains: value, mode: "insensitive" } } } },
          );
        },
      };
    case "ancestor":
      return {
        match: (b) => ({ id: { in: [...new Set(ids(b).flatMap((root) => env.descendants.get(root) ?? []))] } }),
        isEmpty: null,
      };
    case "milestone":
      return {
        match: (b) => ({ id: { in: [...new Set(ids(b).flatMap((m) => env.milestoneItems.get(m) ?? []))] } }),
        isEmpty: { id: { notIn: env.milestoneLinked } },
      };
    case "rank":
      throw new Error(`${id} is not compiled in this phase`);
  }
}

function cfCompiler(key: string, type: CustomFieldType): FieldCompiler {
  const at = (f: Omit<Prisma.JsonNullableFilter<"WorkItem">, "path">): Where => ({ customFields: { path: [key], ...f } });
  // Empty: never set (or JSON null), or cleared to "" / []. Checkboxes are
  // never empty; an unset one is false.
  const isEmpty = or(at({ equals: Prisma.AnyNull }), at({ equals: "" }), at({ equals: [] }));
  const c = cfCompilerOf(type, at);
  return type === "CHECKBOX" ? c : { ...c, isEmpty };
}

function cfCompilerOf(type: CustomFieldType, at: (f: Omit<Prisma.JsonNullableFilter<"WorkItem">, "path">) => Where): FieldCompiler {
  switch (type) {
    case "NUMBER":
      return {
        match: (b) => or(...scalars(b).map((v) => at({ equals: Number(v) }))),
        isEmpty: null,
        order: (cmp, b) => at({ [cmp]: Number((b as { v: number }).v) }),
      };
    case "DATE":
      return {
        match: (b) =>
          or(
            ...b
              .filter((x): x is Extract<Bound, { k: "time" }> => x.k === "time")
              .map((t) => at({ gte: isoDay(t.from), lt: isoDay(t.to) })),
          ),
        isEmpty: null,
        // Stored as YYYY-MM-DD strings, which compare correctly as text.
        order: (cmp, b) => {
          const t = b as Extract<Bound, { k: "time" }>;
          const bound = cmp === "lte" || cmp === "gt" ? (t.day ? t.to : t.from) : t.from;
          return at({ [cmp === "lte" ? "lt" : cmp === "gt" ? "gte" : cmp]: isoDay(bound) });
        },
      };
    case "MULTI_SELECT":
      return {
        match: (b) => or(...scalars(b).map((v) => at({ array_contains: [String(v)] }))),
        matchAll: (b) => at({ array_contains: scalars(b).map(String) }),
        isEmpty: null,
      };
    case "CHECKBOX":
      return { match: (b) => or(...scalars(b).map((v) => at({ equals: v === true }))), isEmpty: null };
    case "USER":
      return { match: (b) => or(...ids(b).map((id) => at({ equals: id }))), isEmpty: null };
    case "TEXT":
    case "URL":
    case "EMAIL":
      return {
        match: (b) => or(...scalars(b).map((v) => at({ equals: String(v) }))),
        isEmpty: null,
        // Like `summary ~`: contains, case-insensitive, LIKE wildcards escaped; a trailing * is a prefix.
        text: (q) => (q.endsWith("*") ? at({ string_starts_with: likeText(q), mode: "insensitive" }) : at({ string_contains: likeText(q), mode: "insensitive" })),
      };
    default:
      // SELECT: exact value.
      return { match: (b) => or(...scalars(b).map((v) => at({ equals: String(v) }))), isEmpty: null };
  }
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── History ──────────────────────────────────────────────────────────────────

type ActivityWhere = Prisma.ActivityWhereInput;
type HistoryLeaf = Extract<LeafNode, { op: "was" | "changed" }>;

/**
 * How one history clause is answered: the id prefilters it needs (at most
 * one), and its where given their results.
 */
type HistoryPlan = { specs: HistorySpec[]; build(idsOf: (spec: HistorySpec) => string[]): Where };

/** The values a history clause names, as Activity stores them. */
function historySet(values: CqlValue[], field: FieldRef, env: CompileEnv): HistoryValueSet {
  const b = bind(values, field, env);
  return {
    values: [...ids(b), ...scalars(b).map(String)],
    ranges: b
      .filter((x): x is Extract<Bound, { k: "time" }> => x.k === "time")
      // A date value means its whole day, as `=` does.
      .map((t) => (t.day ? t : { ...t, ...dayOf(t.from, env.tz) }))
      .map((t) => ({ from: t.from.toISOString(), to: t.to.toISOString() })),
    empty: hasEmpty(b),
  };
}

/** AFTER / BEFORE / ON / DURING as one [from, to) window; null ends are open. */
function historyWindow(p: HistoryPreds, env: CompileEnv): { from: Date | null; to: Date | null } {
  let from: Date | null = null;
  let to: Date | null = null;
  const narrow = (lo: Date | null, hi: Date | null) => {
    if (lo && (!from || lo > from)) from = lo;
    if (hi && (!to || hi < to)) to = hi;
  };
  const time = (v: CqlValue) => timeOf(v, env) as Extract<Bound, { k: "time" }>;
  if (p.after) {
    // After a day means after the whole day; after an instant, from it.
    const t = time(p.after);
    narrow(t.day ? t.to : t.from, null);
  }
  if (p.before) narrow(null, time(p.before).from);
  if (p.on) {
    const t = time(p.on);
    const d = t.day ? t : dayOf(t.from, env.tz);
    narrow(d.from, d.to);
  }
  if (p.during) {
    const a = time(p.during[0]);
    const b = time(p.during[1]);
    narrow(a.from, b.day ? b.to : new Date(b.from.getTime() + 1));
  }
  return { from, to };
}

/**
 * An Activity value column matching a set. Dates are stored as
 * `toISOString()` text, one fixed width, so text order is time order and a
 * day is a [from, to) range of strings.
 */
function activityMatch(column: "oldValue" | "newValue", set: HistoryValueSet): ActivityWhere {
  const parts: ActivityWhere[] = [
    ...(set.values.length ? [{ [column]: { in: set.values } }] : []),
    ...set.ranges.map((r) => ({ [column]: { gte: r.from, lt: r.to } })),
    ...(set.empty ? [{ [column]: null }] : []),
  ];
  if (parts.length === 0) return { id: { in: [] } };
  return parts.length === 1 ? parts[0] : { OR: parts };
}

/** The item's current value matching a set. Nullable columns stay two-valued under NOT. */
function currentMatch(h: (typeof HISTORY)[HistoryField], set: HistoryValueSet): Where {
  const col = (filter: Record<string, unknown>): Where =>
    h.nullable ? nn(h.column, filter) : ({ [h.column]: filter } as Where);
  return or(
    ...(set.values.length ? [col({ in: set.values })] : []),
    ...set.ranges.map((r) => col({ gte: new Date(r.from), lt: new Date(r.to) })),
    ...(set.empty ? [{ [h.column]: null } as Where] : []),
  );
}

function historyPlan(n: HistoryLeaf, env: CompileEnv): HistoryPlan {
  const id = n.field.kind === "sys" ? n.field.id : "";
  if (!isHistoryColumn(id)) throw new Error(`${id} has no history`);
  const h = HISTORY[id];
  const p = n.preds ?? {};
  const win = historyWindow(p, env);
  const timed = !!(win.from || win.to);
  const by = p.by ? ids(bind(predValues(p.by), HISTORY_BY_FIELD, env)) : undefined;
  const window = { ...(win.from ? { gte: win.from } : {}), ...(win.to ? { lt: win.to } : {}) };
  const act = (w: ActivityWhere, opts: { by?: boolean; window?: boolean } = { by: true, window: true }): Where => ({
    activities: {
      some: {
        action: "updated",
        field: h.activity,
        ...w,
        ...(opts.by && by ? { userId: { in: by } } : {}),
        ...(opts.window && timed ? { createdAt: window } : {}),
      },
    },
  });
  const plain = (where: Where): HistoryPlan => ({ specs: [], build: () => where });

  if (n.op === "changed") {
    const from = p.from ? historySet(predValues(p.from), n.field, env) : undefined;
    const to = p.to ? historySet(predValues(p.to), n.field, env) : undefined;
    const values = [...(from ? [activityMatch("oldValue", from)] : []), ...(to ? [activityMatch("newValue", to)] : [])];
    return plain(act(values.length ? { AND: values } : {}));
  }

  const set = historySet(n.values, n.field, env);
  // `WAS v BY u`: u changed it to v (Jira).
  if (by) return plain(act(activityMatch("newValue", set)));
  // Untimed: holds v now, or a recorded change left or entered v.
  if (!timed) return plain(or(currentMatch(h, set), act({ OR: [activityMatch("oldValue", set), activityMatch("newValue", set)] })));

  // Held v at some instant in the window: it held v when the window opened
  // or a change inside the window set it (an id prefilter, bounded by the
  // window's activity), or it holds v now and nothing was recorded since the
  // window closed.
  const spec: HistorySpec = { kind: "window", field: id, set, from: win.from?.toISOString() ?? null, to: win.to?.toISOString() ?? null };
  // Only BEFORE (no lower bound): "held v when the window opened" would be the
  // value each item started with, read off its first change ever, which is a
  // scan of the org's whole history of the field. Instead: a recorded change
  // before the window closed entered or left v (a per-item EXISTS on the
  // (item, field, time) index), or nothing was recorded before it and its
  // first change, at or after it, started from v (the prefilter, bounded by
  // the activity since the window closed).
  const opened = win.from
    ? []
    : [act({ OR: [activityMatch("oldValue", set), activityMatch("newValue", set)] })];
  return {
    specs: [spec],
    build: (idsOf) =>
      or(
        ...opened,
        { id: { in: idsOf(spec) } },
        and(
          currentMatch(h, set),
          ...(win.to ? [{ createdAt: { lt: win.to } }, { NOT: act({ createdAt: { gte: win.to } }, {}) }] : []),
        ),
      ),
  };
}

function compileHistory(n: HistoryLeaf, env: CompileEnv): Where {
  const positive = historyPlan(n, env).build((spec) => {
    const hit = env.history.get(historyKey(spec));
    if (!hit) throw new Error("history prefilter missing; run historySpecs() first");
    return hit;
  });
  return n.op === "was" && n.negate ? not(positive) : positive;
}

/** The id prefilters a query's history clauses need, for history.server.ts to run before compiling. */
export function historySpecs(where: CqlNode | null | undefined, env: CompileEnv): HistorySpec[] {
  const out = new Map<string, HistorySpec>();
  const visit = (n: CqlNode) => {
    if (n.op === "and" || n.op === "or") n.args.forEach(visit);
    else if (n.op === "not") visit(n.arg);
    else if (n.op === "was" || n.op === "changed") {
      try {
        for (const spec of historyPlan(n, env).specs) out.set(historyKey(spec), spec);
      } catch (e) {
        if (!(e instanceof Inert)) throw e;
      }
    }
  };
  if (where) visit(where);
  return [...out.values()];
}

function compilerFor(field: FieldRef, env: CompileEnv): FieldCompiler {
  if (field.kind === "sys") return sysCompiler(field.id, env);
  const type = env.customFields.get(field.key);
  if (!type) throw new Error(`Unknown custom field ${field.key}`);
  return cfCompiler(field.key, type);
}

function compileLeaf(n: LeafNode, env: CompileEnv): Where {
  const c = compilerFor(n.field, env);
  try {
    switch (n.op) {
      case "empty": {
        if (!c.isEmpty) return n.negate ? TRUE : FALSE;
        return n.negate ? not(c.isEmpty) : c.isEmpty;
      }
      case "text": {
        if (!c.text) throw new Error("no text match");
        const w = c.text(n.query);
        if (!n.negate) return w;
        // A custom field's `!~`, like its `!=`, leaves out items where it is empty.
        return n.field.kind === "cf" && c.isEmpty ? and(not(w), not(c.isEmpty)) : not(w);
      }
      case "in":
      case "cmp": {
        const values = n.op === "in" ? n.values : [n.value];
        const bound = bind(values, n.field, env);
        if (n.op === "cmp" && n.cmp !== "eq" && n.cmp !== "neq") {
          if (!c.order) throw new Error("not ordered");
          return c.order(n.cmp, bound[0]);
        }
        const nonEmpty = bound.filter((x) => x.k !== "empty");
        const wantsEmpty = hasEmpty(bound) && c.isEmpty;
        const all = n.op === "in" && n.all && c.matchAll;
        const positive = or(
          ...(nonEmpty.length ? [all ? c.matchAll!(nonEmpty) : c.match(nonEmpty)] : []),
          ...(wantsEmpty ? [c.isEmpty!] : []),
        );
        const negate = (n.op === "cmp" && n.cmp === "neq") || (n.op === "in" && n.negate);
        if (!negate) return positive;
        // Jira: `!=` / NOT IN never match the empty value, unless EMPTY is listed.
        return c.isEmpty && !wantsEmpty ? and(not(positive), not(c.isEmpty)) : not(positive);
      }
      case "was":
      case "changed":
        return compileHistory(n, env);
    }
  } catch (e) {
    if (e instanceof Inert) return TRUE;
    throw e;
  }
}

export function compileNode(n: CqlNode, env: CompileEnv): Where {
  switch (n.op) {
    case "and":
      return and(...n.args.map((a) => compileNode(a, env)));
    case "or":
      return or(...n.args.map((a) => compileNode(a, env)));
    case "not":
      return not(compileNode(n.arg, env));
    default:
      return compileLeaf(n, env);
  }
}

const SORT_COLUMN: Partial<Record<SystemFieldId, string>> = {
  key: "ticketNumber",
  created: "createdAt",
  updated: "updatedAt",
  due: "dueDate",
  start: "startDate",
  actualStart: "actualStart",
  completed: "completedAt",
  statusChanged: "columnEnteredAt",
  archivedAt: "archivedAt",
  points: "storyPoints",
  originalEstimate: "originalEstimate",
  remainingEstimate: "remainingEstimate",
  timeSpent: "timeSpent",
  rank: "sortOrder",
  priority: "priority",
};
const NULLABLE_SORT = new Set(["dueDate", "startDate", "actualStart", "completedAt", "columnEnteredAt", "archivedAt", "storyPoints", "originalEstimate", "remainingEstimate", "timeSpent"]);

export function compileOrderBy(sorts: CqlSort[] | undefined): Prisma.WorkItemOrderByWithRelationInput[] {
  const out: Prisma.WorkItemOrderByWithRelationInput[] = [];
  for (const s of sorts ?? []) {
    if (s.field.kind !== "sys") continue;
    if (s.field.id === "type") {
      out.push({ workItemType: { name: s.dir } });
      continue;
    }
    const col = SORT_COLUMN[s.field.id];
    if (!col) continue;
    // Priority is declared CRITICAL→LOW in the enum, so ASC already means
    // CRITICAL first, matching buildOrderBy.
    if (NULLABLE_SORT.has(col)) {
      // Postgres' default (NULLS LAST for ASC, FIRST for DESC) unless asked.
      const nulls = s.nulls ?? (s.dir === "asc" ? "last" : "first");
      out.push({ [col]: { sort: s.dir, nulls } } as Prisma.WorkItemOrderByWithRelationInput);
    } else {
      out.push({ [col]: s.dir } as Prisma.WorkItemOrderByWithRelationInput);
    }
  }
  // A stable tiebreak so pages never overlap or skip.
  out.push({ createdAt: "desc" }, { id: "desc" });
  return out;
}

/** The user predicate, the archived mode it implies, and the ORDER BY. */
export function compileQuery(q: CqlQuery, env: CompileEnv): Compiled {
  const mentions = mentionsField(q, "archived") || mentionsField(q, "archivedAt");
  return {
    where: q.where ? compileNode(q.where, env) : TRUE,
    // The default hides archived work, unless the query talks about archiving.
    archived: mentions ? "all" : "active",
    orderBy: compileOrderBy(q.orderBy),
    sqlSort: sqlSortOf(q.orderBy, env),
  };
}

function sqlSortOf(sorts: CqlSort[] | undefined, env: CompileEnv): SqlSortKey[] | null {
  if (!sorts?.some((s) => s.field.kind === "cf" || SQL_ONLY_SORT.has(s.field.id))) return null;
  return sorts.map((s) => ({
    field: s.field,
    dir: s.dir,
    // Postgres' default, as compileOrderBy uses.
    nulls: s.nulls ?? (s.dir === "asc" ? "last" : "first"),
    ...(s.field.kind === "cf" ? { cfType: env.customFields.get(s.field.key) } : {}),
  }));
}
