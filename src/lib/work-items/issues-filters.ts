/**
 * PURE serialization for the org-wide Issues view's filter bar. No React, no
 * DB — just the filter-state shape and the mappings between it and:
 *   - the search API query string (`toQueryString`),
 *   - a shareable / reload-stable browser URL (`serializeIssueFilters` +
 *     `parseIssueFilters`),
 *   - a persisted board / saved-view filter (`toWorkItemFilter`,
 *     `filterStateToSavedFilter`, `savedFilterToFilterState`).
 *
 * Kept out of `issues-view.tsx` so it can be exhaustively unit-tested (see
 * `issues-filters.test.ts`) without pulling the client component's module graph.
 * The URL round-trip is what lets applied filters — including the time-based
 * created/updated ranges — survive a page reload and travel through a copied
 * link (COSMOS-16).
 */
import type { WorkItemFilter } from "@/lib/work-items/query/filter";

/** Sentinel for a single-select facet's "Any" (inert) value. */
export const ANY = "__any__";

/** The Issues filter-bar state. Single-select facets hold either a concrete id
 *  or the `ANY` sentinel; the free-text box and the four date-range bounds hold
 *  a string ("" = unset); `watchedByMe` is a boolean toggle. */
export interface FilterState {
  project: string;
  type: string;
  status: string;
  priority: string;
  assignee: string;
  label: string;
  text: string;
  // Date-range bounds (YYYY-MM-DD; "" = unset). Active when non-empty, unlike
  // the ANY-sentinel select fields above.
  createdFrom: string;
  createdTo: string;
  updatedFrom: string;
  updatedTo: string;
  /** FR 8702c9b8 — restrict to items the current user watches. */
  watchedByMe: boolean;
}

/** Filter keys whose "inactive" value is an empty string (not the ANY
 *  sentinel) — the free-text box and the four date-range bounds. */
export const STRING_FILTER_KEYS = [
  "text",
  "createdFrom",
  "createdTo",
  "updatedFrom",
  "updatedTo",
] as const satisfies readonly (keyof FilterState)[];

export const EMPTY_FILTERS: FilterState = {
  project: ANY,
  type: ANY,
  status: ANY,
  priority: ANY,
  assignee: ANY,
  label: ANY,
  text: "",
  createdFrom: "",
  createdTo: "",
  updatedFrom: "",
  updatedTo: "",
  watchedByMe: false,
};

/** Minimal read-only structural type so the parser accepts BOTH the native
 *  `URLSearchParams` and Next's `useSearchParams()` return value without
 *  importing from next/navigation here (keeps this module React-free). */
type ReadonlyParams = { get(name: string): string | null };

/**
 * Write the ACTIVE filter fields onto a URLSearchParams. Shared by the search
 * API query string (`toQueryString`) and the shareable browser URL
 * (`serializeIssueFilters`) so the two stay in lock-step. An inert field (ANY /
 * empty) is omitted, yielding a clean, minimal query.
 */
function writeFilterParams(p: URLSearchParams, f: FilterState): void {
  if (f.project !== ANY) p.set("project", f.project);
  if (f.type !== ANY) p.set("type", f.type);
  if (f.status !== ANY) p.set("status", f.status);
  if (f.priority !== ANY) p.set("priority", f.priority);
  if (f.assignee !== ANY) p.set("assignee", f.assignee);
  if (f.label !== ANY) p.set("label", f.label);
  const text = f.text.trim();
  if (text) p.set("text", text);
  if (f.createdFrom) p.set("createdFrom", f.createdFrom);
  if (f.createdTo) p.set("createdTo", f.createdTo);
  if (f.updatedFrom) p.set("updatedFrom", f.updatedFrom);
  if (f.updatedTo) p.set("updatedTo", f.updatedTo);
  if (f.watchedByMe) p.set("watchedByMe", "1");
}

/** Build the search API query string from the active filters + page. */
export function toQueryString(f: FilterState, page: number, pageSize: number): string {
  const p = new URLSearchParams();
  writeFilterParams(p, f);
  p.set("page", String(page));
  p.set("pageSize", String(pageSize));
  return p.toString();
}

/**
 * Serialize the active filters into a shareable / reload-stable URL query string
 * (no pagination — a shared link lands on page 1). Mirror of
 * `parseIssueFilters`; keep the two in lock-step.
 */
export function serializeIssueFilters(f: FilterState): string {
  const p = new URLSearchParams();
  writeFilterParams(p, f);
  return p.toString();
}

/**
 * Reconstruct FilterState from a URL's search params so a shared / reloaded
 * Issues link restores its filters — including the created/updated time ranges
 * (COSMOS-16 AC: "persist across page reloads/shared views"). Absent values fall
 * back to the empty defaults. Mirror of `serializeIssueFilters`.
 */
export function parseIssueFilters(params: ReadonlyParams): FilterState {
  const sel = (k: string) => params.get(k) || ANY;
  const str = (k: string) => params.get(k) ?? "";
  return {
    project: sel("project"),
    type: sel("type"),
    status: sel("status"),
    priority: sel("priority"),
    assignee: sel("assignee"),
    label: sel("label"),
    text: str("text"),
    createdFrom: str("createdFrom"),
    createdTo: str("createdTo"),
    updatedFrom: str("updatedFrom"),
    updatedTo: str("updatedTo"),
    watchedByMe: params.get("watchedByMe") === "1",
  };
}

/**
 * Map the Issues filter-bar state into the query lib's WorkItemFilter (the shape
 * persisted as a board's saved view). Mirrors `writeFilterParams`' mapping; the
 * project pin is intentionally NOT included — a saved board carries its own
 * project and the server re-pins scope on every read.
 */
export function toWorkItemFilter(f: FilterState): WorkItemFilter {
  const filter: WorkItemFilter = {};
  if (f.type !== ANY) filter.typeIds = [f.type];
  if (f.status !== ANY) filter.columnKeys = [f.status];
  if (f.priority !== ANY) {
    filter.priorities = [f.priority] as WorkItemFilter["priorities"];
  }
  if (f.assignee !== ANY) filter.assigneeIds = [f.assignee];
  if (f.label !== ANY) filter.labels = [f.label];
  const text = f.text.trim();
  if (text) filter.text = text;
  if (f.createdFrom || f.createdTo) {
    filter.createdAt = { from: f.createdFrom || undefined, to: f.createdTo || undefined };
  }
  if (f.updatedFrom || f.updatedTo) {
    filter.updatedAt = { from: f.updatedFrom || undefined, to: f.updatedTo || undefined };
  }
  return filter;
}

/**
 * Map the filter bar into a saved-view filter (FR 2b36c2b8). Unlike
 * `toWorkItemFilter` (board-oriented), this PRESERVES the project pin — a saved
 * view like "my project-X bugs" should re-select the project on apply.
 */
export function filterStateToSavedFilter(f: FilterState): WorkItemFilter {
  const filter = toWorkItemFilter(f);
  if (f.project !== ANY) filter.projectIds = [f.project];
  return filter;
}

/**
 * Inverse of `filterStateToSavedFilter` — apply a stored view to the filter bar.
 * Single-select fields take the first array member; unknowns fall back to ANY so
 * a stale/partial saved filter can't wedge the UI.
 */
export function savedFilterToFilterState(wf: WorkItemFilter): FilterState {
  const first = (arr?: string[]) => (arr && arr.length > 0 ? arr[0] : ANY);
  return {
    ...EMPTY_FILTERS,
    project: first(wf.projectIds),
    type: first(wf.typeIds),
    status: first(wf.columnKeys),
    priority: first(wf.priorities as string[] | undefined),
    assignee: first(wf.assigneeIds),
    label: first(wf.labels),
    text: wf.text ?? "",
    createdFrom: wf.createdAt?.from ?? "",
    createdTo: wf.createdAt?.to ?? "",
    updatedFrom: wf.updatedAt?.from ?? "",
    updatedTo: wf.updatedAt?.to ?? "",
  };
}
