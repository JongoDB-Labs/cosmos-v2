"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useWorkItemRealtime } from "@/hooks/use-work-item-realtime";
import { DataTable } from "@/components/ui/data-table";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { SaveAsBoardDialog } from "@/components/work-items/save-as-board-dialog";
import type { ActionMenuGroup } from "@/components/ui/action-menu";
import { IssueDetailSheet } from "@/components/work-items/issue-detail-sheet";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";
import { AlertTriangle, ListFilter, Save, Search, X, Eye, ExternalLink, Link2 } from "lucide-react";
import { toast } from "sonner";

/** Row shape returned by GET /api/v1/orgs/[orgId]/work-items/search. Mirrors
 *  IssueRow in @/lib/work-items/query (kept local to avoid a server import). */
interface IssueRow {
  id: string;
  ticketNumber: number;
  ticketKey: string;
  title: string;
  columnKey: string;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  type: { id: string; key: string; name: string; icon: string | null; color: string | null };
  project: { id: string; key: string; name: string };
  assignee: { id: string; displayName: string; avatarUrl: string | null } | null;
  parent: { id: string; ticketKey: string; title: string } | null;
  cycleId: string | null;
  storyPoints: number | null;
  tags: string[];
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Facets {
  projects: { id: string; key: string; name: string; archived: boolean }[];
  types: { id: string; key: string; name: string; icon: string | null; color: string | null }[];
  statuses: { key: string; name: string; category: string }[];
  members: { id: string; displayName: string; avatarUrl: string | null }[];
  labels: string[];
  cycles: { id: string; name: string; number: number; projectId: string; status: string }[];
  /** Projects the actor can administer (org PROJECT_MANAGE or project MANAGER).
   *  Lets a project manager who lacks org-wide BOARD_CREATE still save a board. */
  managedProjectIds: string[];
}

interface SearchResponse {
  data: IssueRow[];
  total: number;
}

const ANY = "__any__";

const PRIORITY_VARIANT: Record<IssueRow["priority"], BadgeVariant> = {
  CRITICAL: "critical",
  HIGH: "blocked",
  MEDIUM: "review",
  LOW: "neutral",
};

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  TODO: "neutral",
  IN_PROGRESS: "progress",
  DONE: "done",
};

interface FilterState {
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
}

/** Filter keys whose "inactive" value is an empty string (not the ANY
 *  sentinel) — the free-text box and the four date-range bounds. */
const STRING_FILTER_KEYS = [
  "text",
  "createdFrom",
  "createdTo",
  "updatedFrom",
  "updatedTo",
] as const satisfies readonly (keyof FilterState)[];

const EMPTY_FILTERS: FilterState = {
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
};

/** Build the search query string from the active filters + page. */
function toQueryString(f: FilterState, page: number, pageSize: number): string {
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
  p.set("page", String(page));
  p.set("pageSize", String(pageSize));
  return p.toString();
}

/** Map the Issues filter-bar state into the query lib's WorkItemFilter (the
 *  shape persisted as a board's saved view). Mirrors toQueryString's mapping;
 *  the project pin is intentionally NOT included — a saved board carries its own
 *  project and the server re-pins scope on every read. */
function toWorkItemFilter(f: FilterState): WorkItemFilter {
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

const PAGE_SIZE = 25;

export function IssuesView({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { can } = usePermissions();
  // Org-wide board-create. A project MANAGER whose org role lacks it can still
  // save a board for their own project — folded in below once facets resolve.
  const hasOrgBoardCreate = can(Permission.BOARD_CREATE);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  // The text input is uncontrolled-ish: we commit it into `filters.text` on
  // submit/enter so every keystroke doesn't refire the query.
  const [textDraft, setTextDraft] = useState("");
  const [page, setPage] = useState(1);
  const [saveBoardOpen, setSaveBoardOpen] = useState(false);
  const [detailRow, setDetailRow] = useState<IssueRow | null>(null);
  const router = useRouter();

  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const activeCount = useMemo(
    () =>
      (Object.keys(filters) as (keyof FilterState)[]).filter((k) =>
        (STRING_FILTER_KEYS as readonly string[]).includes(k)
          ? (filters[k] as string).trim() !== ""
          : filters[k] !== ANY,
      ).length,
    [filters],
  );

  const facetsKey = useOrgQueryKey("issues", "facets");
  const facetsQuery = useQuery({
    queryKey: facetsKey,
    queryFn: () => jsonFetch<Facets>(`/api/v1/orgs/${orgId}/work-items/facets`),
    staleTime: 60_000,
  });

  const qs = toQueryString(filters, page, PAGE_SIZE);
  const resultsKey = useOrgQueryKey("issues", "search", qs);
  const {
    data: results,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: resultsKey,
    queryFn: () =>
      jsonFetch<SearchResponse>(`/api/v1/orgs/${orgId}/work-items/search?${qs}`),
    placeholderData: keepPreviousData,
  });

  // Live updates: re-run the current cross-project search whenever ANY project's
  // work items change (FR: "issue updates without manual refresh"). keepPrevious
  // data means the table doesn't flash while it refetches.
  useWorkItemRealtime(orgId, null, () => void refetch());

  const facets = facetsQuery.data;
  // Show "Save as board" to org board-creators AND to project managers (who can
  // create boards for the projects they manage, per the board POST's inheritance).
  const managedProjectIds = facets?.managedProjectIds ?? [];
  const canCreateBoard = hasOrgBoardCreate || managedProjectIds.length > 0;
  const rows = results?.data ?? [];
  const total = results?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns = useMemo<ColumnDef<IssueRow>[]>(
    () => [
      {
        accessorKey: "ticketKey",
        header: "Key",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-[var(--primary)]">
            {row.original.ticketKey}
          </span>
        ),
      },
      {
        accessorKey: "title",
        header: "Title",
        cell: ({ row }) => (
          <span
            className="block max-w-md truncate font-medium"
            title={row.original.title}
          >
            {row.original.title}
            {row.original.parent && (
              <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                ↳ {row.original.parent.ticketKey}
              </span>
            )}
          </span>
        ),
      },
      {
        accessorKey: "type",
        header: "Type",
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 text-sm">
            {row.original.type.icon && <span aria-hidden>{row.original.type.icon}</span>}
            {row.original.type.name}
          </span>
        ),
      },
      {
        accessorKey: "project",
        header: "Project",
        cell: ({ row }) => (
          <Badge variant="neutral">{row.original.project.key || "—"}</Badge>
        ),
      },
      {
        accessorKey: "columnKey",
        header: "Status",
        cell: ({ row }) => {
          const status = facets?.statuses.find((s) => s.key === row.original.columnKey);
          const variant = status ? STATUS_VARIANT[status.category] ?? "neutral" : "neutral";
          return <Badge variant={variant}>{status?.name ?? row.original.columnKey}</Badge>;
        },
      },
      {
        accessorKey: "priority",
        header: "Priority",
        cell: ({ row }) => (
          <Badge variant={PRIORITY_VARIANT[row.original.priority]}>
            {row.original.priority}
          </Badge>
        ),
      },
      {
        accessorKey: "assignee",
        header: "Assignee",
        cell: ({ row }) =>
          row.original.assignee ? (
            <div className="flex items-center gap-2">
              <Avatar className="h-6 w-6">
                <AvatarImage src={row.original.assignee.avatarUrl ?? undefined} />
                <AvatarFallback className="text-[10px]">
                  {row.original.assignee.displayName.charAt(0)}
                </AvatarFallback>
              </Avatar>
              <span className="text-sm">{row.original.assignee.displayName}</span>
            </div>
          ) : (
            <span className="text-sm text-[var(--text-muted)]">Unassigned</span>
          ),
      },
      {
        accessorKey: "dueDate",
        header: "Due",
        cell: ({ row }) =>
          row.original.dueDate ? (
            <span className="text-sm">
              {new Date(row.original.dueDate).toLocaleDateString("en-US", {
                timeZone: "UTC",
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          ) : (
            <span className="text-sm text-[var(--text-muted)]">—</span>
          ),
      },
    ],
    [facets],
  );

  // Per-row actions — surfaced by DataTable as a ⋯ column AND on right-click.
  const rowActions = useCallback(
    (r: IssueRow): ActionMenuGroup[] => {
      const boardHref = `/${orgSlug}/projects/${r.project.key}`;
      return [
        {
          items: [
            { label: "View details", icon: Eye, onClick: () => setDetailRow(r) },
            { label: "Open in board", icon: ExternalLink, onClick: () => router.push(boardHref) },
            {
              label: "Copy link",
              icon: Link2,
              onClick: () => {
                try {
                  void navigator.clipboard?.writeText(`${window.location.origin}${boardHref}`);
                  toast.success("Board link copied");
                } catch {
                  /* clipboard unavailable */
                }
              },
            },
          ],
        },
      ];
    },
    [orgSlug, router],
  );

  return (
    <div className="space-y-4">
      <FilterBar
        filters={filters}
        textDraft={textDraft}
        setTextDraft={setTextDraft}
        onCommitText={() => set("text", textDraft)}
        onChange={set}
        onClear={() => {
          setFilters(EMPTY_FILTERS);
          setTextDraft("");
          setPage(1);
        }}
        activeCount={activeCount}
        facets={facets}
        facetsLoading={facetsQuery.isLoading}
        facetsError={facetsQuery.isError}
        onRetryFacets={() => void facetsQuery.refetch()}
      />

      {isError ? (
        <LoadError
          title="Couldn't load issues"
          description="Something went wrong while running your search."
          onRetry={() => void refetch()}
        />
      ) : isLoading ? (
        <TableSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          illustration={<ListFilter className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden />}
          title={activeCount > 0 ? "No issues match these filters" : "No issues yet"}
          description={
            activeCount > 0
              ? "Try widening or clearing some filters."
              : "Work items across your projects will show up here."
          }
          action={
            activeCount > 0 ? (
              <Button
                variant="outline"
                onClick={() => {
                  setFilters(EMPTY_FILTERS);
                  setTextDraft("");
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>
              {total.toLocaleString()} issue{total === 1 ? "" : "s"}
              {isFetching && <span className="ml-2 opacity-70">updating…</span>}
            </span>
            {canCreateBoard && (facets?.projects.length ?? 0) > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setSaveBoardOpen(true)}
              >
                <Save className="h-3.5 w-3.5" aria-hidden />
                Save as board
              </Button>
            )}
          </div>
          <DataTable
            columns={columns}
            data={rows}
            getRowId={(r) => r.id}
            onRowClick={(r) => setDetailRow(r)}
            rowActions={rowActions}
          />
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-[var(--border)] pt-3 text-xs text-[var(--text-muted)]">
              <span>
                Page {page} of {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <IssueDetailSheet
        row={detailRow}
        open={detailRow !== null}
        onOpenChange={(o) => !o && setDetailRow(null)}
        orgId={orgId}
        orgSlug={orgSlug}
        statuses={facets?.statuses ?? []}
      />

      {canCreateBoard && facets && (
        <SaveAsBoardDialog
          open={saveBoardOpen}
          onOpenChange={setSaveBoardOpen}
          orgId={orgId}
          orgSlug={orgSlug}
          filter={toWorkItemFilter(filters)}
          projects={
            // A project manager without org-wide BOARD_CREATE may only target the
            // projects they manage — don't offer one whose POST would 403.
            hasOrgBoardCreate
              ? facets.projects
              : facets.projects.filter((p) => managedProjectIds.includes(p.id))
          }
          defaultProjectId={
            filters.project !== ANY ? filters.project : undefined
          }
        />
      )}
    </div>
  );
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

function FilterBar({
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
        className="bg-transparent text-xs outline-none [color-scheme:light] dark:[color-scheme:dark]"
      />
      <span className="text-[var(--text-muted)]">→</span>
      <input
        type="date"
        value={to}
        min={from || undefined}
        onChange={(e) => onTo(e.target.value)}
        aria-label={`${label} to`}
        className="bg-transparent text-xs outline-none [color-scheme:light] dark:[color-scheme:dark]"
      />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
      <div className="space-y-px">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-6 w-6 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
