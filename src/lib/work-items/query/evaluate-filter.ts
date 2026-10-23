/**
 * In-memory twin of `buildWorkItemWhere`: does one loaded work item satisfy a
 * `WorkItemFilter`?
 *
 * WHY. A board saved from the Issues view stores that view's filter in
 * `Board.config.savedFilter`. Boards load their project's items and filter them
 * in the browser, so the saved filter has to be evaluated there, with the SAME
 * meaning the server gives it: a board that disagrees with the Issues list it
 * was saved from is the bug this exists to fix. `evaluate-filter.db.test.ts`
 * runs both over the same rows and asserts they agree.
 *
 * Project scope and RBAC are not this function's concern: the board's items are
 * already one readable project's. `watchedByUserId` needs the watcher set, which
 * board rows don't carry, so a filter using it is reported by `evaluable()`
 * rather than silently matched.
 */
import { buildDateRange } from "./build-where";
import { NO_INTERVAL, UNASSIGNED, type WorkItemFilter } from "./filter";

/** The fields the evaluator reads. Board rows and Prisma rows both fit. */
export interface EvaluableItem {
  id: string;
  workItemTypeId: string;
  columnKey: string;
  priority: string;
  assigneeId: string | null;
  assignees?: { userId: string }[];
  tags: string[];
  intervalId: string | null;
  parentId: string | null;
  title: string;
  description: string | null;
  customFields: unknown;
  archivedAt?: string | Date | null;
  startDate: string | Date | null;
  dueDate: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

const set = (values: string[] | undefined) =>
  new Set((values ?? []).filter((v) => typeof v === "string" && v.length > 0));

function inRange(value: string | Date | null, range: WorkItemFilter["dueDate"]): boolean {
  const r = buildDateRange(range);
  if (!r) return true;
  // SQL: a NULL date never satisfies gte/lte.
  if (value == null) return false;
  const t = new Date(value).getTime();
  return (!r.gte || t >= r.gte.getTime()) && (!r.lte || t <= r.lte.getTime());
}

/** Filters this evaluator cannot decide from a board row. */
export function evaluable(filter: WorkItemFilter): { ok: true } | { ok: false; reason: string } {
  return filter.watchedByUserId
    ? { ok: false, reason: "watchedByUserId needs the watcher list" }
    : { ok: true };
}

export function matchesWorkItemFilter(item: EvaluableItem, filter: WorkItemFilter): boolean {
  const archived = item.archivedAt != null;
  if (filter.archived === "only" && !archived) return false;
  if ((filter.archived ?? "active") === "active" && archived) return false;

  const ids = set(filter.ids);
  if (ids.size > 0 && !ids.has(item.id)) return false;

  const types = set(filter.typeIds);
  if (types.size > 0 && !types.has(item.workItemTypeId)) return false;

  const columns = set(filter.columnKeys);
  if (columns.size > 0 && !columns.has(item.columnKey)) return false;

  if (filter.priorities && filter.priorities.length > 0 && !filter.priorities.includes(item.priority as never)) {
    return false;
  }

  const assignees = set(filter.assigneeIds);
  if (assignees.size > 0) {
    const members = item.assignees ?? [];
    const unassigned = item.assigneeId == null && members.length === 0;
    const hit =
      (assignees.has(UNASSIGNED) && unassigned)
      || (item.assigneeId != null && assignees.has(item.assigneeId))
      || members.some((a) => assignees.has(a.userId));
    if (!hit) return false;
  }

  const labels = set(filter.labels);
  if (labels.size > 0 && !item.tags.some((t) => labels.has(t))) return false;

  const intervals = set(filter.intervalIds);
  if (intervals.size > 0) {
    const hit = item.intervalId == null ? intervals.has(NO_INTERVAL) : intervals.has(item.intervalId);
    if (!hit) return false;
  }

  if (filter.parent) {
    const p = filter.parent;
    if (p.mode === "has_parent" && item.parentId == null) return false;
    if (p.mode === "no_parent" && item.parentId != null) return false;
    // An empty `is` list matches nothing, as on the server.
    if (p.mode === "is" && (item.parentId == null || !set(p.parentIds).has(item.parentId))) return false;
  }

  if (!inRange(item.startDate, filter.startDate)) return false;
  if (!inRange(item.dueDate, filter.dueDate)) return false;
  if (!inRange(item.createdAt, filter.createdAt)) return false;
  if (!inRange(item.updatedAt, filter.updatedAt)) return false;

  const text = filter.text?.trim().toLowerCase();
  if (text) {
    const hit =
      item.title.toLowerCase().includes(text)
      || (item.description ?? "").toLowerCase().includes(text);
    if (!hit) return false;
  }

  const cf = (item.customFields && typeof item.customFields === "object" ? item.customFields : {}) as Record<
    string,
    unknown
  >;
  for (const c of filter.customFields ?? []) {
    const key = c.key?.trim();
    if (!key) continue;
    const v = cf[key];
    if (c.kind === "MULTI_SELECT") {
      if (typeof c.value !== "string" || c.value === "") continue;
      if (!Array.isArray(v) || !v.includes(c.value)) return false;
    } else if (c.kind === "CHECKBOX") {
      if (v !== (c.value === true)) return false;
    } else {
      if (typeof c.value !== "string" || c.value === "") continue;
      if (v !== c.value) return false;
    }
  }

  return true;
}
