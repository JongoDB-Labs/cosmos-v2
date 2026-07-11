/**
 * Pure helpers for the Custom Dashboards surface (COSMOS-87).
 *
 * A "dashboard" is a saved, named, reusable work-item filter — persisted as a
 * {@link SavedView} (a serialised `WorkItemFilter` JSON blob) and shared with
 * the Issues view's saved filters. This module maps between the dashboard filter
 * BAR (a small single-select state: project / status / assignee / tag + text)
 * and the serialisable `WorkItemFilter`, and turns a filter into the query
 * string the org-wide work-item search endpoint understands (`parseSearchParams`
 * in `lib/work-items/query/parse.ts` is the exact inverse).
 *
 * Everything here is pure (no React, no DB, no fetch) so it can be exhaustively
 * unit-tested and reused by both the client component and its tests.
 */
import type { WorkItemFilter } from "@/lib/work-items/query/filter";

/** Sentinel for an inactive single-select bar field ("Any"). */
export const ANY = "__any__" as const;

/** Matches items with no assignee — mirrors the query layer's UNASSIGNED. */
export const UNASSIGNED = "unassigned" as const;

/**
 * The dashboard filter bar state — one single-select per acceptance-criteria
 * dimension (assignee, status, project, tag), plus a free-text box. Each select
 * is `ANY` when inactive; `text` is `""` when inactive.
 */
export interface DashboardFilterState {
  /** Project.id, or ANY. */
  project: string;
  /** Board column key (the work item's status lane), or ANY. */
  status: string;
  /** Assignee User.id (or UNASSIGNED), or ANY. */
  assignee: string;
  /** Tag/label value, or ANY. */
  label: string;
  /** Free-text search over title/description (trimmed on use); "" = inactive. */
  text: string;
}

/** An all-"Any" bar — the default before a dashboard/filter is chosen. */
export const EMPTY_DASHBOARD_FILTER: DashboardFilterState = {
  project: ANY,
  status: ANY,
  assignee: ANY,
  label: ANY,
  text: "",
};

/** True when no bar dimension constrains the result set. */
export function isEmptyFilterState(state: DashboardFilterState): boolean {
  return (
    state.project === ANY &&
    state.status === ANY &&
    state.assignee === ANY &&
    state.label === ANY &&
    state.text.trim() === ""
  );
}

/** First element of a string array, or the fallback when absent/empty. */
function firstOr(arr: readonly string[] | undefined, fallback: string): string {
  return arr && arr.length > 0 ? arr[0] : fallback;
}

/**
 * Seed the bar from a stored filter. Multi-value fields collapse to their first
 * member (the bar is single-select). Fields the bar doesn't expose (type,
 * priority, date ranges…) are ignored HERE but preserved on save — see
 * {@link applyStateToFilter}.
 */
export function workItemFilterToState(wf: WorkItemFilter): DashboardFilterState {
  return {
    project: firstOr(wf.projectIds, ANY),
    status: firstOr(wf.columnKeys, ANY),
    assignee: firstOr(wf.assigneeIds, ANY),
    label: firstOr(wf.labels, ANY),
    text: wf.text ?? "",
  };
}

/**
 * Overlay the bar's four dimensions + text onto a base filter. A field set to
 * `ANY` / empty CLEARS that dimension; anything else PINS it. Non-bar fields on
 * `base` (type, priority, cycle, date ranges) are preserved — so opening a saved
 * view that constrains type+status, tweaking just the assignee, and re-saving
 * keeps the original type constraint intact.
 */
export function applyStateToFilter(
  base: WorkItemFilter,
  state: DashboardFilterState,
): WorkItemFilter {
  const out: WorkItemFilter = { ...base };

  if (state.project === ANY) delete out.projectIds;
  else out.projectIds = [state.project];

  if (state.status === ANY) delete out.columnKeys;
  else out.columnKeys = [state.status];

  if (state.assignee === ANY) delete out.assigneeIds;
  else out.assigneeIds = [state.assignee];

  if (state.label === ANY) delete out.labels;
  else out.labels = [state.label];

  const text = state.text.trim();
  if (text) out.text = text;
  else delete out.text;

  return out;
}

/**
 * Serialise a filter into the query string the search endpoint parses. Multi-
 * value fields become repeated params (`?project=a&project=b`), which
 * `parseSearchParams` reads back verbatim; date ranges map to their
 * `<field>From` / `<field>To` params. `page`/`pageSize` are always set.
 *
 * Fields the dashboard bar can't set (type/priority/cycle/date ranges) are still
 * serialised so a saved view authored on the Issues page renders faithfully.
 */
export function workItemFilterToSearchParams(
  wf: WorkItemFilter,
  page: number,
  pageSize: number,
): URLSearchParams {
  const p = new URLSearchParams();
  const addAll = (key: string, values?: readonly string[]) => {
    for (const v of values ?? []) if (v) p.append(key, v);
  };

  addAll("project", wf.projectIds);
  addAll("type", wf.typeIds);
  addAll("status", wf.columnKeys);
  addAll("priority", wf.priorities as readonly string[] | undefined);
  addAll("assignee", wf.assigneeIds);
  addAll("label", wf.labels);
  addAll("cycle", wf.cycleIds);

  const text = wf.text?.trim();
  if (text) p.set("text", text);

  if (wf.createdAt?.from) p.set("createdFrom", wf.createdAt.from);
  if (wf.createdAt?.to) p.set("createdTo", wf.createdAt.to);
  if (wf.updatedAt?.from) p.set("updatedFrom", wf.updatedAt.from);
  if (wf.updatedAt?.to) p.set("updatedTo", wf.updatedAt.to);
  if (wf.startDate?.from) p.set("startFrom", wf.startDate.from);
  if (wf.startDate?.to) p.set("startTo", wf.startDate.to);
  if (wf.dueDate?.from) p.set("dueFrom", wf.dueDate.from);
  if (wf.dueDate?.to) p.set("dueTo", wf.dueDate.to);

  p.set("page", String(page));
  p.set("pageSize", String(pageSize));
  return p;
}

/** A board status lane, as returned by the work-item facets endpoint. */
export interface StatusFacet {
  key: string;
  name: string;
  category: string;
}

/** A status lane plus the rows that currently sit in it. */
export interface StatusGroup<T> {
  key: string;
  name: string;
  category: string;
  rows: T[];
}

/**
 * Group rows by their status lane for the standup-friendly presentation view.
 * Group order follows `statuses` (the facet order, i.e. board sort order); a row
 * whose status isn't in the facet list is bucketed under its own key and
 * appended after the known lanes in first-appearance order. Empty lanes are
 * omitted so the presentation only shows lanes that actually have work.
 */
export function groupRowsByStatus<T extends { columnKey: string }>(
  rows: readonly T[],
  statuses: readonly StatusFacet[],
): StatusGroup<T>[] {
  const facetByKey = new Map(statuses.map((s) => [s.key, s]));
  const buckets = new Map<string, T[]>();
  const unknownOrder: string[] = [];

  for (const row of rows) {
    const key = row.columnKey;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      if (!facetByKey.has(key)) unknownOrder.push(key);
    }
    bucket.push(row);
  }

  const groups: StatusGroup<T>[] = [];
  // Known lanes first, in facet order — only those that actually have rows.
  for (const s of statuses) {
    const bucket = buckets.get(s.key);
    if (bucket && bucket.length > 0) {
      groups.push({ key: s.key, name: s.name, category: s.category, rows: bucket });
    }
  }
  // Unknown lanes (no matching facet) appended in first-appearance order.
  for (const key of unknownOrder) {
    groups.push({ key, name: key, category: "UNKNOWN", rows: buckets.get(key)! });
  }
  return groups;
}
