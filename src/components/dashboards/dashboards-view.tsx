"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ANY,
  EMPTY_DASHBOARD_FILTER,
  UNASSIGNED,
  applyStateToFilter,
  groupRowsByStatus,
  isEmptyFilterState,
  workItemFilterToSearchParams,
  workItemFilterToState,
  type DashboardFilterState,
} from "@/lib/dashboards/filter";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";
import {
  LayoutGrid,
  ChevronDown,
  Bookmark,
  Trash2,
  Users,
  Lock,
  Presentation,
  X,
} from "lucide-react";

/** A saved dashboard — a named, reusable work-item filter (shares storage with
 *  the Issues view's saved views). Mirrors the saved-views API response. */
interface SavedDashboard {
  id: string;
  name: string;
  filter: WorkItemFilter;
  shared: boolean;
  mine: boolean;
  ownerName: string;
}

/** The filter-bar option lists — a subset of the work-item facets response. */
interface Facets {
  projects: { id: string; key: string; name: string; archived: boolean }[];
  statuses: { key: string; name: string; category: string }[];
  members: { id: string; displayName: string; avatarUrl: string | null }[];
  labels: string[];
}

/** A row in the presentation list — a subset of the search endpoint's IssueRow. */
interface DashboardItem {
  id: string;
  ticketKey: string;
  title: string;
  columnKey: string;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  project: { id: string; key: string; name: string };
  assignee: { id: string; displayName: string; avatarUrl: string | null } | null;
  assignees?: { id: string; displayName: string; avatarUrl: string | null }[];
  tags: string[];
}

interface SearchResponse {
  data: DashboardItem[];
  total: number;
}

const PRIORITY_VARIANT: Record<DashboardItem["priority"], BadgeVariant> = {
  CRITICAL: "critical",
  HIGH: "blocked",
  MEDIUM: "review",
  LOW: "neutral",
};

const CATEGORY_VARIANT: Record<string, BadgeVariant> = {
  TODO: "neutral",
  IN_PROGRESS: "progress",
  DONE: "done",
};

/** Present the whole result set at once (no pagination UI — a dashboard is a
 *  focused, filtered slice meant for a standup, not the full backlog). Capped at
 *  the query layer's MAX_PAGE_SIZE. */
const PRESENT_LIMIT = 100;

function stateEquals(a: DashboardFilterState, b: DashboardFilterState): boolean {
  return (
    a.project === b.project &&
    a.status === b.status &&
    a.assignee === b.assignee &&
    a.label === b.label &&
    a.text.trim() === b.text.trim()
  );
}

/**
 * Custom Dashboards (COSMOS-87) — create, name, save, and quick-switch between
 * filtered views of work items across every project you can read. A dashboard is
 * persisted as a saved work-item filter; the selected one is reflected in the URL
 * (`?view=<id>`) so it's bookmarkable and reopens across sessions. The layout is
 * deliberately roomy and grouped-by-status so it reads well on a shared screen
 * during a standup.
 */
export function DashboardsView({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewParam = searchParams.get("view");

  const [filters, setFilters] = useState<DashboardFilterState>(EMPTY_DASHBOARD_FILTER);
  // The selected dashboard's FULL stored filter (or {} for an ad-hoc filter).
  // Bar edits overlay this so non-bar constraints (type/priority) are preserved.
  const [baseFilter, setBaseFilter] = useState<WorkItemFilter>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveShared, setSaveShared] = useState(false);
  const [textDraft, setTextDraft] = useState("");

  const savedKey = useOrgQueryKey("saved-views");
  const { data: dashboards = [] } = useQuery({
    queryKey: savedKey,
    queryFn: () => jsonFetch<SavedDashboard[]>(`/api/v1/orgs/${orgId}/saved-views`),
    staleTime: 30_000,
  });

  const facetsKey = useOrgQueryKey("issues", "facets");
  const { data: facets } = useQuery({
    queryKey: facetsKey,
    queryFn: () => jsonFetch<Facets>(`/api/v1/orgs/${orgId}/work-items/facets`),
    staleTime: 60_000,
  });

  // Apply a dashboard (or clear) to both local state and the URL. Selecting one
  // pins `?view=<id>` so the choice survives a reload / can be shared.
  const applied = useRef<string | null | undefined>(undefined);
  const applyState = (id: string | null) => {
    applied.current = id;
    const view = id ? dashboards.find((d) => d.id === id) : undefined;
    if (!view) {
      setSelectedId(null);
      setBaseFilter({});
      setFilters(EMPTY_DASHBOARD_FILTER);
      setTextDraft("");
      return;
    }
    setSelectedId(view.id);
    setBaseFilter(view.filter);
    const next = workItemFilterToState(view.filter);
    setFilters(next);
    setTextDraft(next.text);
  };

  const pinViewParam = (id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("view", id);
    else url.searchParams.delete("view");
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  };

  const selectView = (id: string | null) => {
    pinViewParam(id);
    applyState(id);
  };

  // Adopt a known dashboard object directly (bypassing the list lookup). Used
  // right after a save, when the just-created dashboard isn't in the refetched
  // list yet — going through selectView() would find nothing and reset.
  const adoptDashboard = (d: SavedDashboard) => {
    applied.current = d.id;
    setSelectedId(d.id);
    setBaseFilter(d.filter);
    const next = workItemFilterToState(d.filter);
    setFilters(next);
    setTextDraft(next.text);
    pinViewParam(d.id);
  };

  // Resolve `?view=<id>` on first load and on browser back/forward. Guarded so
  // it never clobbers in-place bar edits (they don't touch the URL param).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (viewParam === applied.current) return;
    // Wait for the list before resolving a deep-linked id.
    if (viewParam && dashboards.length === 0) return;
    applyState(viewParam ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewParam, dashboards]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const set = <K extends keyof DashboardFilterState>(key: K, value: DashboardFilterState[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  const selected = useMemo(
    () => dashboards.find((d) => d.id === selectedId) ?? null,
    [dashboards, selectedId],
  );
  const modified = useMemo(
    () => (selected ? !stateEquals(filters, workItemFilterToState(selected.filter)) : false),
    [selected, filters],
  );

  // The effective filter: bar dimensions overlaid on the selected view's filter.
  const effectiveFilter = useMemo(
    () => applyStateToFilter(baseFilter, filters),
    [baseFilter, filters],
  );
  const qs = useMemo(
    () => workItemFilterToSearchParams(effectiveFilter, 1, PRESENT_LIMIT).toString(),
    [effectiveFilter],
  );

  const resultsKey = useOrgQueryKey("dashboards", "search", qs);
  const {
    data: results,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: resultsKey,
    queryFn: () => jsonFetch<SearchResponse>(`/api/v1/orgs/${orgId}/work-items/search?${qs}`),
    placeholderData: keepPreviousData,
  });

  const createDashboard = useOrgMutation<
    SavedDashboard,
    Error,
    { name: string; filter: WorkItemFilter; shared: boolean }
  >({
    mutationFn: (body) =>
      jsonFetch(`/api/v1/orgs/${orgId}/saved-views`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    invalidate: [["saved-views"]],
  });

  const deleteDashboard = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/saved-views/${id}`, { method: "DELETE" }),
    invalidate: [["saved-views"]],
  });

  async function save() {
    const trimmed = saveName.trim();
    if (!trimmed) return;
    try {
      const created = await createDashboard.mutateAsync({
        name: trimmed,
        filter: effectiveFilter,
        shared: saveShared,
      });
      toast.success(`Saved dashboard "${trimmed}"`);
      setSaveOpen(false);
      setSaveName("");
      setSaveShared(false);
      // Switch to the freshly-saved dashboard so it's the active, shareable view.
      adoptDashboard(created);
    } catch (err) {
      notifyError(err, "Couldn't save the dashboard.");
    }
  }

  async function remove(id: string, name: string) {
    try {
      await deleteDashboard.mutateAsync(id);
      toast.success(`Deleted dashboard "${name}"`);
      if (selectedId === id) selectView(null);
    } catch (err) {
      notifyError(err, "Couldn't delete the dashboard.");
    }
  }

  const mine = dashboards.filter((d) => d.mine);
  const sharedByOthers = dashboards.filter((d) => !d.mine && d.shared);

  const projectOpts = (facets?.projects ?? []).map((p) => ({ value: p.id, label: p.name }));
  const statusOpts = (facets?.statuses ?? []).map((s) => ({ value: s.key, label: s.name }));
  const assigneeOpts = [
    { value: UNASSIGNED, label: "Unassigned" },
    ...(facets?.members ?? []).map((m) => ({ value: m.id, label: m.displayName })),
  ];
  const labelOpts = (facets?.labels ?? []).map((l) => ({ value: l, label: l }));

  const rows = useMemo(() => results?.data ?? [], [results]);
  const total = results?.total ?? 0;
  const groups = useMemo(
    () => groupRowsByStatus(rows, facets?.statuses ?? []),
    [rows, facets?.statuses],
  );
  const noReadableProjects = facets != null && facets.projects.length === 0;
  const anyFilter = !isEmptyFilterState(filters) || Object.keys(baseFilter).length > 0;

  return (
    <div className="space-y-5">
      {/* Toolbar: dashboard switcher + save. */}
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="Switch dashboard"
                className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
              />
            }
          >
            <LayoutGrid className="h-4 w-4" />
            <span className="max-w-48 truncate">{selected ? selected.name : "All items"}</span>
            {modified && <span className="text-xs text-[var(--text-muted)]">· edited</span>}
            <ChevronDown className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-64">
            <DropdownMenuItem onClick={() => selectView(null)}>
              <Presentation className="mr-2 h-3.5 w-3.5" /> All items (no filter)
            </DropdownMenuItem>
            {(mine.length > 0 || sharedByOthers.length > 0) && <DropdownMenuSeparator />}
            {mine.length > 0 && (
              <DropdownMenuGroup>
                <DropdownMenuLabel>My dashboards</DropdownMenuLabel>
                {mine.map((d) => (
                  <DashboardRow
                    key={d.id}
                    dashboard={d}
                    active={d.id === selectedId}
                    onApply={() => selectView(d.id)}
                    onDelete={() => void remove(d.id, d.name)}
                    deletable
                  />
                ))}
              </DropdownMenuGroup>
            )}
            {sharedByOthers.length > 0 && (
              <DropdownMenuGroup>
                <DropdownMenuLabel>Shared with the team</DropdownMenuLabel>
                {sharedByOthers.map((d) => (
                  <DashboardRow
                    key={d.id}
                    dashboard={d}
                    active={d.id === selectedId}
                    onApply={() => selectView(d.id)}
                  />
                ))}
              </DropdownMenuGroup>
            )}
            {mine.length === 0 && sharedByOthers.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-[var(--text-muted)]">
                No saved dashboards yet — set some filters and save one.
              </p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="outline"
          className="gap-1.5"
          disabled={!anyFilter}
          onClick={() => {
            // Prefill a "(copy)" name only when editing an existing dashboard —
            // saving under its exact name would 409 (names are unique per owner).
            setSaveName(selected && modified ? `${selected.name} (copy)` : "");
            setSaveShared(selected?.shared ?? false);
            setSaveOpen(true);
          }}
        >
          <Bookmark className="h-4 w-4" /> Save as dashboard
        </Button>

        {(modified || (!selected && anyFilter)) && (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-[var(--text-muted)]"
            // Revert edits back to the saved dashboard, or clear ad-hoc filters.
            onClick={() => (modified && selectedId ? applyState(selectedId) : selectView(null))}
          >
            <X className="h-3.5 w-3.5" /> Reset
          </Button>
        )}

        {isFetching && !isLoading && (
          <span className="text-xs text-[var(--text-muted)]">Updating…</span>
        )}
      </div>

      {/* Filter bar — the four AC dimensions + free text. */}
      <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
        <FilterSelect
          label="Project"
          value={filters.project}
          onValueChange={(v) => set("project", v)}
          options={projectOpts}
        />
        <FilterSelect
          label="Status"
          value={filters.status}
          onValueChange={(v) => set("status", v)}
          options={statusOpts}
        />
        <FilterSelect
          label="Assignee"
          value={filters.assignee}
          onValueChange={(v) => set("assignee", v)}
          options={assigneeOpts}
        />
        <FilterSelect
          label="Tag"
          value={filters.label}
          onValueChange={(v) => set("label", v)}
          options={labelOpts}
        />
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            set("text", textDraft);
          }}
        >
          <Input
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            onBlur={() => filters.text !== textDraft && set("text", textDraft)}
            placeholder="Search text…"
            aria-label="Search text"
            className="h-8 w-44"
          />
        </form>
      </div>

      {/* Presentation surface. */}
      {isError ? (
        <LoadError onRetry={() => void refetch()} />
      ) : isLoading ? (
        <PresentSkeleton />
      ) : noReadableProjects ? (
        <EmptyState
          icon={LayoutGrid}
          title="No items to show"
          description="You don't have access to any projects with work items yet."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title="Nothing matches this dashboard"
          description={
            anyFilter
              ? "No work items match the current filters. Try loosening them."
              : "Pick some filters above, then save the result as a dashboard."
          }
        />
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-[var(--text-muted)]">
            {total} {total === 1 ? "item" : "items"}
            {total > rows.length && ` · showing first ${rows.length}`}
          </p>
          {groups.map((g) => (
            <section key={g.key}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold tracking-tight text-[var(--text)]">
                  {g.name}
                </h2>
                <Badge variant={CATEGORY_VARIANT[g.category] ?? "neutral"}>{g.rows.length}</Badge>
              </div>
              <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                {g.rows.map((row) => (
                  <li key={row.id}>
                    <Link
                      href={`/${orgSlug}/issues?item=${row.id}`}
                      className="flex items-center gap-3 p-3 transition-colors hover:bg-[var(--muted)]/40"
                    >
                      <span className="w-20 shrink-0 font-mono text-xs text-[var(--text-muted)]">
                        {row.ticketKey}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">
                        {row.title}
                      </span>
                      <Badge variant="neutral" className="hidden sm:inline-flex">
                        {row.project.key || "—"}
                      </Badge>
                      <Badge variant={PRIORITY_VARIANT[row.priority]}>
                        {row.priority.charAt(0) + row.priority.slice(1).toLowerCase()}
                      </Badge>
                      <AssigneeAvatars assignee={row.assignee} assignees={row.assignees} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* Save dialog. */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as dashboard</DialogTitle>
            <DialogDescription>
              Save the current filters as a reusable dashboard you can switch back to any time.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Input
              autoFocus
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && saveName.trim()) {
                  e.preventDefault();
                  void save();
                }
              }}
              placeholder="Dashboard name (e.g. Standup — my open tasks)"
              maxLength={80}
            />
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 text-[var(--text)]">
                {saveShared ? <Users className="size-4" /> : <Lock className="size-4" />}
                {saveShared ? "Shared with the whole team" : "Only visible to me"}
              </span>
              <ToggleSwitch
                checked={saveShared}
                onCheckedChange={setSaveShared}
                aria-label="Share with the team"
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={!saveName.trim() || createDashboard.isPending}>
              {createDashboard.isPending ? "Saving…" : "Save dashboard"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A single "Label: value | Any" filter select, mirroring the Issues filter bar. */
function FilterSelect({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string }[];
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

/** Stacked assignee avatars (primary + up to two extras) or an "Unassigned" tag. */
function AssigneeAvatars({
  assignee,
  assignees,
}: {
  assignee: DashboardItem["assignee"];
  assignees: DashboardItem["assignees"];
}) {
  if (!assignee) {
    return <span className="hidden shrink-0 text-xs text-[var(--text-muted)] md:inline">Unassigned</span>;
  }
  const extras = (assignees ?? []).filter((x) => x.id !== assignee.id);
  return (
    <div className="flex shrink-0 -space-x-1.5">
      {[assignee, ...extras].slice(0, 3).map((u) => (
        <Avatar key={u.id} className="h-6 w-6 ring-1 ring-[var(--surface)]" title={u.displayName}>
          <AvatarImage src={u.avatarUrl ?? undefined} />
          <AvatarFallback className="text-[10px]">{u.displayName.charAt(0)}</AvatarFallback>
        </Avatar>
      ))}
    </div>
  );
}

/** A dashboard entry in the switcher dropdown, with an optional delete affordance. */
function DashboardRow({
  dashboard,
  active,
  onApply,
  onDelete,
  deletable = false,
}: {
  dashboard: SavedDashboard;
  active: boolean;
  onApply: () => void;
  onDelete?: () => void;
  deletable?: boolean;
}) {
  return (
    <div className="flex items-center">
      <DropdownMenuItem className={cn("flex-1", active && "font-medium")} onClick={onApply}>
        {dashboard.shared ? (
          <Users className="mr-2 h-3.5 w-3.5 text-[var(--text-muted)]" />
        ) : (
          <Lock className="mr-2 h-3.5 w-3.5 text-[var(--text-muted)]" />
        )}
        <span className="truncate">{dashboard.name}</span>
        {!dashboard.mine && (
          <span className="ml-1 text-[10px] text-[var(--text-muted)]">· {dashboard.ownerName}</span>
        )}
      </DropdownMenuItem>
      {deletable && onDelete && (
        <button
          type="button"
          aria-label={`Delete dashboard ${dashboard.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="mr-1 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--muted)]/50 hover:text-[var(--status-critical)]"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function PresentSkeleton() {
  return (
    <div className="space-y-6">
      {[0, 1].map((s) => (
        <div key={s}>
          <Skeleton className="mb-2 h-4 w-28" />
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex items-center gap-4 border-b border-[var(--border)] p-3 last:border-b-0"
              >
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-5 w-14" />
                <Skeleton className="h-6 w-6 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
