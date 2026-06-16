/**
 * PURE Prisma where-builder for the cross-project work-item query. No DB, no
 * async, no I/O — so it is exhaustively unit-testable (see build-where.test.ts).
 *
 * RBAC is non-negotiable here: every result is constrained to `orgId` AND to
 * `allowedProjectIds` (the projects the actor may see, resolved upstream in
 * `scope.ts`). If a `projectIds` filter is supplied it is INTERSECTED with the
 * allowed set — a user can never widen their scope by naming a project they
 * can't access. An empty allowed set yields a where that matches nothing.
 */
import type { Prisma } from "@prisma/client";
import {
  type WorkItemFilter,
  type WorkItemSort,
  NO_CYCLE,
  UNASSIGNED,
} from "./filter";

export interface BuildWhereArgs {
  orgId: string;
  /** Projects the actor is allowed to see. The result is ALWAYS scoped to this
   *  set (intersected with any `filter.projectIds`). */
  allowedProjectIds: string[];
  filter: WorkItemFilter;
}

/** Dedup + drop falsy values from a possibly-undefined string array. */
function clean(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
}

/** Intersect two string sets (order follows `a`). */
function intersect(a: string[], b: Set<string>): string[] {
  return a.filter((x) => b.has(x));
}

/**
 * Build a `Prisma.WorkItemWhereInput` for the given filter, hard-scoped to the
 * org + allowed projects. The returned object is safe to pass straight to
 * `prisma.workItem.findMany`/`count`.
 */
export function buildWorkItemWhere(args: BuildWhereArgs): Prisma.WorkItemWhereInput {
  const { orgId, filter } = args;
  const allowed = clean(args.allowedProjectIds);
  const allowedSet = new Set(allowed);

  // ── Project scope (RBAC) ─────────────────────────────────────────────
  // Start from the allowed set, then narrow by the explicit project filter.
  // Intersection — never union — so a named project can't escape the ceiling.
  const requested = clean(filter.projectIds);
  const effectiveProjectIds =
    requested.length > 0 ? intersect(requested, allowedSet) : allowed;

  // An empty effective set means "nothing visible" → a where that matches
  // nothing (projectId IN []), rather than silently dropping the scope.
  const where: Prisma.WorkItemWhereInput = {
    orgId,
    projectId: { in: effectiveProjectIds },
  };

  const and: Prisma.WorkItemWhereInput[] = [];

  // ── Work-item type ───────────────────────────────────────────────────
  const typeIds = clean(filter.typeIds);
  if (typeIds.length > 0) where.workItemTypeId = { in: typeIds };

  // ── Status / column ──────────────────────────────────────────────────
  const columnKeys = clean(filter.columnKeys);
  if (columnKeys.length > 0) where.columnKey = { in: columnKeys };

  // ── Priority ─────────────────────────────────────────────────────────
  if (filter.priorities && filter.priorities.length > 0) {
    where.priority = { in: [...new Set(filter.priorities)] };
  }

  // ── Assignee (supports the "unassigned" sentinel, OR-combined) ───────
  const assigneeIds = clean(filter.assigneeIds);
  if (assigneeIds.length > 0) {
    const wantsUnassigned = assigneeIds.includes(UNASSIGNED);
    const realIds = assigneeIds.filter((id) => id !== UNASSIGNED);
    const or: Prisma.WorkItemWhereInput[] = [];
    if (realIds.length > 0) or.push({ assigneeId: { in: realIds } });
    if (wantsUnassigned) or.push({ assigneeId: null });
    if (or.length === 1) {
      Object.assign(where, or[0]);
    } else if (or.length > 1) {
      and.push({ OR: or });
    }
  }

  // ── Labels / tags (HAS-ANY) ──────────────────────────────────────────
  const labels = clean(filter.labels);
  if (labels.length > 0) where.tags = { hasSome: labels };

  // ── Cycle / sprint (supports the "none" sentinel, OR-combined) ───────
  const cycleIds = clean(filter.cycleIds);
  if (cycleIds.length > 0) {
    const wantsNone = cycleIds.includes(NO_CYCLE);
    const realIds = cycleIds.filter((id) => id !== NO_CYCLE);
    const or: Prisma.WorkItemWhereInput[] = [];
    if (realIds.length > 0) or.push({ cycleId: { in: realIds } });
    if (wantsNone) or.push({ cycleId: null });
    if (or.length === 1) {
      Object.assign(where, or[0]);
    } else if (or.length > 1) {
      and.push({ OR: or });
    }
  }

  // ── Parent / hierarchy ───────────────────────────────────────────────
  if (filter.parent) {
    switch (filter.parent.mode) {
      case "has_parent":
        where.parentId = { not: null };
        break;
      case "no_parent":
        where.parentId = null;
        break;
      case "is": {
        const parentIds = clean(filter.parent.parentIds);
        // An empty `is` list is treated as "match nothing" so the filter is not
        // silently ignored.
        where.parentId = { in: parentIds };
        break;
      }
      case "any":
      default:
        break;
    }
  }

  // ── Date ranges (inclusive) ──────────────────────────────────────────
  const startDate = buildDateRange(filter.startDate);
  if (startDate) where.startDate = startDate;
  const dueDate = buildDateRange(filter.dueDate);
  if (dueDate) where.dueDate = dueDate;
  const createdAt = buildDateRange(filter.createdAt);
  if (createdAt) where.createdAt = createdAt;
  const updatedAt = buildDateRange(filter.updatedAt);
  if (updatedAt) where.updatedAt = updatedAt;

  // ── Free-text (title OR description, case-insensitive contains) ──────
  const text = filter.text?.trim();
  if (text) {
    and.push({
      OR: [
        { title: { contains: text, mode: "insensitive" } },
        { description: { contains: text, mode: "insensitive" } },
      ],
    });
  }

  // ── Custom fields (JSON-path equality on WorkItem.customFields) ──────
  // AND-across (each constraint must match). Postgres JSON filtering: SELECT /
  // TEXT / CHECKBOX use `{ path:[key], equals }`; MULTI_SELECT (stored as an
  // array under the key) uses `{ path:[key], array_contains: [value] }`.
  for (const cf of filter.customFields ?? []) {
    const key = cf.key?.trim();
    if (!key) continue;
    if (cf.kind === "MULTI_SELECT") {
      if (typeof cf.value !== "string" || cf.value === "") continue;
      and.push({ customFields: { path: [key], array_contains: [cf.value] } });
    } else if (cf.kind === "CHECKBOX") {
      and.push({ customFields: { path: [key], equals: cf.value === true } });
    } else {
      // SELECT / TEXT — exact match on the scalar at `key`.
      if (typeof cf.value !== "string" || cf.value === "") continue;
      and.push({ customFields: { path: [key], equals: cf.value } });
    }
  }

  if (and.length > 0) where.AND = and;
  return where;
}

/** Translate a DateRange into a Prisma DateTime filter, or null if both edges
 *  are absent / invalid. Invalid date strings are ignored (treated as absent)
 *  rather than throwing — the caller validates inputs at the edge. */
function buildDateRange(
  range: { from?: string; to?: string } | undefined,
): { gte?: Date; lte?: Date } | undefined {
  // A plain { gte?, lte? } is structurally assignable to BOTH Prisma's
  // DateTimeNullableFilter (nullable startDate/dueDate) and DateTimeFilter
  // (non-null createdAt/updatedAt), so the one builder serves all four fields.
  if (!range) return undefined;
  const out: { gte?: Date; lte?: Date } = {};
  const from = parseDate(range.from);
  // A date-only upper bound (YYYY-MM-DD) is snapped to end-of-day so the `lte`
  // is inclusive of the whole day — otherwise "to 2026-06-09" silently drops
  // everything created after midnight that day.
  const to = parseDate(range.to, { endOfDay: true });
  if (from) out.gte = from;
  if (to) out.lte = to;
  return out.gte || out.lte ? out : undefined;
}

function parseDate(
  value: string | undefined,
  opts?: { endOfDay?: boolean },
): Date | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const iso = dateOnly && opts?.endOfDay ? `${value}T23:59:59.999Z` : value;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Build the Prisma `orderBy` for a sort spec, with a stable secondary key
 * (createdAt desc) so pagination is deterministic. Falls back to the default
 * when no sort is supplied.
 */
export function buildOrderBy(
  sort: WorkItemSort | undefined,
): Prisma.WorkItemOrderByWithRelationInput[] {
  const dir = sort?.direction === "asc" ? "asc" : "desc";
  switch (sort?.field) {
    case "priority":
      // Priority is an enum ordered CRITICAL→LOW in the schema; Prisma sorts by
      // declaration order, so "asc" = CRITICAL first.
      return [{ priority: dir }, { createdAt: "desc" }];
    case "dueDate":
      return [{ dueDate: dir }, { createdAt: "desc" }];
    case "startDate":
      return [{ startDate: dir }, { createdAt: "desc" }];
    case "ticketNumber":
      return [{ ticketNumber: dir }, { createdAt: "desc" }];
    case "updatedAt":
      return [{ updatedAt: dir }];
    case "createdAt":
      return [{ createdAt: dir }];
    default:
      return [{ createdAt: "desc" }];
  }
}
