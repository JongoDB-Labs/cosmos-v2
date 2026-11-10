"use client";

/**
 * The Issues filter bar for orgs without CQL: one single-select per facet,
 * two date ranges and the free-text box. Where the org has CQL on, the query
 * builder (cql/query-builder.tsx) replaces it; this goes when the `cql` flag
 * does (query design §13, "Then").
 */
import { useMemo } from "react";
import { AlertTriangle, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";

export interface Facets {
  // `sector` comes from the project's template and scopes the New-issue Type
  // picker. Nullable: a project without a template gets the full catalogue.
  projects: {
    id: string;
    key: string;
    name: string;
    archived: boolean;
    sector: string | null;
  }[];
  types: { id: string; key: string; name: string; icon: string | null; color: string | null }[];
  statuses: { key: string; name: string; category: string }[];
  /** Lane options keyed by project id — the valid statuses for each project's
   *  board, so inline status edits stay scoped to the item's own project. */
  statusesByProject: Record<string, { key: string; name: string; category: string }[]>;
  members: { id: string; displayName: string; avatarUrl: string | null }[];
  labels: string[];
  intervals: { id: string; name: string; number: number; projectId: string; status: string }[];
  /** Projects the actor can administer (org PROJECT_MANAGE or project MANAGER).
   *  Lets a project manager who lacks org-wide BOARD_CREATE still save a board. */
  managedProjectIds: string[];
}

export const ANY = "__any__";

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
  /** Show ONLY archived items. Off by default: archiving exists to get things
   *  out of the way, so this is the one surface that deliberately brings them
   *  back — it is where you go to find one and undo it. It selects rather than
   *  includes, because a control labelled "Archived" that merely ADDED them
   *  looked like it did nothing at all on a list with one archived item. */
  showArchived: boolean;
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
  showArchived: false,
};

/** Build the search query string from the active filters + page. */
export function toQueryString(f: FilterState, page: number, pageSize: number): string {
  const p = new URLSearchParams();
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
  if (f.showArchived) p.set("archived", "only");
  p.set("page", String(page));
  p.set("pageSize", String(pageSize));
  return p.toString();
}

/** Map the Issues filter-bar state into the query lib's WorkItemFilter (the
 *  shape persisted as a board's saved view). Mirrors toQueryString's mapping;
 *  the project pin is intentionally NOT included — a saved board carries its own
 *  project and the server re-pins scope on every read. */
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

/** Map the filter bar into a saved-view filter (FR 2b36c2b8). Unlike
 *  toWorkItemFilter (board-oriented), this PRESERVES the project pin — a saved
 *  view like "my project-X bugs" should re-select the project on apply. */
export function filterStateToSavedFilter(f: FilterState): WorkItemFilter {
  const filter = toWorkItemFilter(f);
  if (f.project !== ANY) filter.projectIds = [f.project];
  return filter;
}

/** Inverse of filterStateToSavedFilter — apply a stored view to the filter bar.
 *  Single-select fields take the first array member; unknowns fall back to ANY
 *  so a stale/partial saved filter can't wedge the UI. */
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

interface FilterBarProps {
  filters: FilterState;
  textDraft: string;
  setTextDraft: (v: string) => void;
  onCommitText: () => void;
  onChange: <K extends keyof FilterState>(key: K, value: FilterState[K]) => void;
  onClear: () => void;
  activeCount: number;
  facets: Facets | undefined;
  facetsLoading: boolean;
  /** The facets request failed — the selects fall back to text-search-only and
   *  we surface a small retry affordance instead of silently empty dropdowns. */
  facetsError: boolean;
  onRetryFacets: () => void;
}

export function FilterBar({
  filters,
  textDraft,
  setTextDraft,
  onCommitText,
  onChange,
  onClear,
  activeCount,
  facets,
  facetsLoading,
  facetsError,
  onRetryFacets,
}: FilterBarProps) {
  // When facets fail to load, the facet selects can't be populated. Keep the
  // text search usable, disable the (empty) selects, and offer a retry — the
  // results LoadError handles the search failure separately.
  const facetsDisabled = facetsLoading || (facetsError && !facets);
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
      {facetsError && !facets && (
        <div className="mb-2 flex items-center gap-2 text-xs text-[var(--status-blocked-text,var(--status-blocked))]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>Couldn&apos;t load filter options.</span>
          <button
            type="button"
            onClick={onRetryFacets}
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <Input
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitText();
            }}
            onBlur={onCommitText}
            placeholder="Search title or description…"
            className="pl-8"
            aria-label="Search issues"
          />
        </div>

        <FacetSelect
          label="Project"
          value={filters.project}
          onValueChange={(v) => onChange("project", v)}
          disabled={facetsDisabled}
          options={(facets?.projects ?? []).map((p) => ({
            value: p.id,
            label: `${p.key} · ${p.name}`,
          }))}
        />
        <FacetSelect
          label="Type"
          value={filters.type}
          onValueChange={(v) => onChange("type", v)}
          disabled={facetsDisabled}
          options={(facets?.types ?? []).map((t) => ({ value: t.id, label: t.name }))}
        />
        <FacetSelect
          label="Status"
          value={filters.status}
          onValueChange={(v) => onChange("status", v)}
          disabled={facetsDisabled}
          options={(facets?.statuses ?? []).map((s) => ({ value: s.key, label: s.name }))}
        />
        <FacetSelect
          label="Priority"
          value={filters.priority}
          onValueChange={(v) => onChange("priority", v)}
          options={[
            { value: "CRITICAL", label: "Critical" },
            { value: "HIGH", label: "High" },
            { value: "MEDIUM", label: "Medium" },
            { value: "LOW", label: "Low" },
          ]}
        />
        <FacetSelect
          label="Assignee"
          value={filters.assignee}
          onValueChange={(v) => onChange("assignee", v)}
          disabled={facetsDisabled}
          options={[
            { value: "unassigned", label: "Unassigned" },
            ...(facets?.members ?? []).map((m) => ({ value: m.id, label: m.displayName })),
          ]}
        />
        {facets && facets.labels.length > 0 && (
          <FacetSelect
            label="Label"
            value={filters.label}
            onValueChange={(v) => onChange("label", v)}
            options={facets.labels.map((l) => ({ value: l, label: l }))}
          />
        )}

        <DateRangeFilter
          label="Created"
          from={filters.createdFrom}
          to={filters.createdTo}
          onFrom={(v) => onChange("createdFrom", v)}
          onTo={(v) => onChange("createdTo", v)}
        />
        <DateRangeFilter
          label="Updated"
          from={filters.updatedFrom}
          to={filters.updatedTo}
          onFrom={(v) => onChange("updatedFrom", v)}
          onTo={(v) => onChange("updatedTo", v)}
        />

        {activeCount > 0 && (
          <Button variant="ghost" size="sm" onClick={onClear} className="gap-1">
            <X className="h-3.5 w-3.5" /> Clear ({activeCount})
          </Button>
        )}
      </div>
    </div>
  );
}

function FacetSelect({
  label,
  value,
  onValueChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  const items = useMemo(() => {
    const map: Record<string, string> = { [ANY]: `${label}: Any` };
    for (const o of options) map[o.value] = `${label}: ${o.label}`;
    return map;
  }, [label, options]);

  return (
    <Select
      items={items}
      value={value}
      onValueChange={(v) => v && onValueChange(v as string)}
      disabled={disabled}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{label}: Any</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {`${label}: ${o.label}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A compact "from → to" pair of native date inputs for a created/updated
 *  range filter. Empty inputs are inert; the label turns active-colored once
 *  either bound is set so it reads like the other filter chips. */
function DateRangeFilter({
  label,
  from,
  to,
  onFrom,
  onTo,
}: {
  label: string;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  const active = from !== "" || to !== "";
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs",
        active && "border-[var(--primary)]",
      )}
    >
      <span className="text-[var(--text-muted)]">{label}:</span>
      <input
        type="date"
        value={from}
        max={to || undefined}
        onChange={(e) => onFrom(e.target.value)}
        aria-label={`${label} from`}
        className="rounded-sm bg-transparent text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [color-scheme:light] dark:[color-scheme:dark]"
      />
      <span className="text-[var(--text-muted)]">→</span>
      <input
        type="date"
        value={to}
        min={from || undefined}
        onChange={(e) => onTo(e.target.value)}
        aria-label={`${label} to`}
        className="rounded-sm bg-transparent text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [color-scheme:light] dark:[color-scheme:dark]"
      />
    </div>
  );
}
