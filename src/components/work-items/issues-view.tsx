"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useWorkItemRealtime } from "@/hooks/use-work-item-realtime";
import { DataTable } from "@/components/ui/data-table";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { SavedViewsPicker } from "@/components/work-items/saved-views-picker";
import { CreateWorkItemDialog } from "@/components/work-items/create-work-item-dialog";
import type { ActionMenuGroup } from "@/components/ui/action-menu";
import { IssueDetailSheet } from "@/components/work-items/issue-detail-sheet";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";
import { planTagAddition, type TagRowInfo } from "@/lib/work-items/bulk-tags";
import { summarizeBulkDelete } from "@/lib/work-items/bulk-delete";
import { AlertTriangle, ListFilter, Save, Search, X, Eye, ExternalLink, Link2, Trash2, Copy, Flag, Plus, Check, Download, Star } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";

/** Best-effort human reason from a rejected bulk request — the server message
 *  carried by a jsonFetch FetchError, or a network error's own message. */
function reasonOf(err: unknown): string {
  return err instanceof Error && err.message.trim()
    ? err.message
    : "an unexpected error";
}

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
  /** Full assignee set (multi-assign), primary first. */
  assignees?: { id: string; displayName: string; avatarUrl: string | null }[];
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
  /** Lane options keyed by project id — the valid statuses for each project's
   *  board, so inline status edits stay scoped to the item's own project. */
  statusesByProject: Record<string, { key: string; name: string; category: string }[]>;
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
  /** FR 8702c9b8 — restrict to items the current user watches. */
  watchedByMe: boolean;
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
  watchedByMe: false,
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
  if (f.watchedByMe) p.set("watchedByMe", "1");
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

/** Map the filter bar into a saved-view filter (FR 2b36c2b8). Unlike
 *  toWorkItemFilter (board-oriented), this PRESERVES the project pin — a saved
 *  view like "my project-X bugs" should re-select the project on apply. */
function filterStateToSavedFilter(f: FilterState): WorkItemFilter {
  const filter = toWorkItemFilter(f);
  if (f.project !== ANY) filter.projectIds = [f.project];
  return filter;
}

/** Inverse of filterStateToSavedFilter — apply a stored view to the filter bar.
 *  Single-select fields take the first array member; unknowns fall back to ANY
 *  so a stale/partial saved filter can't wedge the UI. */
function savedFilterToFilterState(wf: WorkItemFilter): FilterState {
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

const PAGE_SIZE = 25;

export function IssuesView({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { can } = usePermissions();
  // Org-wide board-create. A project MANAGER whose org role lacks it can still
  // save a board for their own project — folded in below once facets resolve.
  const hasOrgBoardCreate = can(Permission.BOARD_CREATE);
  const canBulkEdit = can(Permission.ITEM_BULK_EDIT);
  const canBulkDelete = can(Permission.ITEM_DELETE);
  const canCreateItem = can(Permission.ITEM_CREATE);
  const canUpdateItem = can(Permission.ITEM_UPDATE);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  // The text input is uncontrolled-ish: we commit it into `filters.text` on
  // submit/enter so every keystroke doesn't refire the query.
  const [textDraft, setTextDraft] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [saveBoardOpen, setSaveBoardOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // When set, the create dialog opens as a pre-filled "Duplicate issue" draft
  // seeded from this row (COSMOS-13); null = a blank "New issue".
  const [duplicateSource, setDuplicateSource] = useState<{
    itemId: string;
    projectId: string;
  } | null>(null);
  const [detailRow, setDetailRow] = useState<IssueRow | null>(null);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [bulkPending, setBulkPending] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  // Deep-link: `/issues?watching=1` pre-applies the Watching filter (the "My
  // watched items" widget's "View all"). One-time init, then strip the param.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!searchParams.get("watching")) return;
    setFilters((prev) => (prev.watchedByMe ? prev : { ...prev, watchedByMe: true }));
    const url = new URL(window.location.href);
    url.searchParams.delete("watching");
    router.replace(url.pathname + url.search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Deep-link: `/issues?item=<id>` opens that work item's detail sheet even when
  // it isn't on the current page (mention chips / "Mentioned in" backlinks link
  // here). Fetch the single row (RBAC-scoped), open the sheet, then strip the
  // param so closing it doesn't re-open and the URL stays clean.
  useEffect(() => {
    const itemId = searchParams.get("item");
    if (!itemId) return;
    let cancelled = false;
    jsonFetch<IssueRow>(`/api/v1/orgs/${orgId}/work-items/${itemId}/row`)
      .then((row) => {
        if (!cancelled && row) setDetailRow(row);
      })
      .catch(() => {
        /* item not readable / gone — leave the list as-is */
      });
    const url = new URL(window.location.href);
    url.searchParams.delete("item");
    router.replace(url.pathname + url.search);
    return () => {
      cancelled = true;
    };
  }, [searchParams, orgId, router]);

  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const activeCount = useMemo(
    () =>
      (Object.keys(filters) as (keyof FilterState)[]).filter((k) => {
        if (k === "watchedByMe") return filters.watchedByMe;
        return (STRING_FILTER_KEYS as readonly string[]).includes(k)
          ? (filters[k] as string).trim() !== ""
          : filters[k] !== ANY;
      }).length,
    [filters],
  );

  const facetsKey = useOrgQueryKey("issues", "facets");
  const facetsQuery = useQuery({
    queryKey: facetsKey,
    queryFn: () => jsonFetch<Facets>(`/api/v1/orgs/${orgId}/work-items/facets`),
    staleTime: 60_000,
  });

  const qs = toQueryString(filters, page, pageSize);
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

  // Inline field edit: PUT the single field on the item's project endpoint, then
  // refetch (keepPreviousData avoids a flash). Used by the click-to-edit cells.
  const quickUpdate = useCallback(
    async (row: IssueRow, patch: Record<string, unknown>, label: string) => {
      try {
        await jsonFetch(
          `/api/v1/orgs/${orgId}/projects/${row.project.id}/work-items/${row.id}`,
          { method: "PUT", body: JSON.stringify(patch) },
        );
        toast.success(`${row.ticketKey} · ${label}`);
        void refetch();
      } catch (err) {
        notifyError(err, "Couldn't update the issue.");
      }
    },
    [orgId, refetch],
  );

  const facets = facetsQuery.data;
  // Show "Save as board" to org board-creators AND to project managers (who can
  // create boards for the projects they manage, per the board POST's inheritance).
  const managedProjectIds = facets?.managedProjectIds ?? [];
  const canCreateBoard = hasOrgBoardCreate || managedProjectIds.length > 0;
  const rows = results?.data ?? [];

  // ── Bulk edit (cross-project) ───────────────────────────────────────────
  // Issues rows span projects, but the bulk API is per-project — so we bucket
  // the selected ids by their project and fan out one request per project. We
  // only expose project-AGNOSTIC ops here (assignee/priority/tags/delete);
  // status + cycle are project-scoped and stay in the per-project table view.
  const selectedIds = Object.keys(rowSelection).filter((id) => rowSelection[id]);
  const selectedCount = selectedIds.length;

  // Cross-page "select all matching" (BR f6b52435): the table is server-
  // paginated, so the page checkbox can only reach the loaded rows. This
  // walks the same search query page-by-page collecting id→projectId for
  // EVERY match, so bulk ops can fan out beyond the visible page.
  const [selectingAll, setSelectingAll] = useState(false);
  // id → { projectId, tags } for EVERY match captured by "select all matching".
  // projectId lets bulk ops fan out per project beyond the visible page; tags
  // let bulkAddTag append to off-page items (the bulk PUT replaces the array).
  const allMatchesRef = useRef<Map<string, TagRowInfo> | null>(null);
  const SELECT_ALL_CAP = 2500;
  // Mirrors the search API's MAX_PAGE_SIZE (lib/work-items/query/filter.ts).
  const MAX_SEARCH_PAGE = 100;

  async function selectAllMatching() {
    if (selectingAll) return;
    setSelectingAll(true);
    try {
      const map = new Map<string, TagRowInfo>();
      const pages = Math.ceil(total / MAX_SEARCH_PAGE);
      const cappedPages = Math.min(pages, SELECT_ALL_CAP / MAX_SEARCH_PAGE);
      for (let p = 1; p <= cappedPages; p++) {
        const res = await jsonFetch<SearchResponse>(
          `/api/v1/orgs/${orgId}/work-items/search?${toQueryString(filters, p, MAX_SEARCH_PAGE)}`,
        );
        for (const r of res.data) map.set(r.id, { projectId: r.project.id, tags: r.tags });
      }
      allMatchesRef.current = map;
      const next: RowSelectionState = {};
      for (const id of map.keys()) next[id] = true;
      setRowSelection(next);
      if (total > SELECT_ALL_CAP) {
        toast.info(`Selected the first ${SELECT_ALL_CAP.toLocaleString()} matching issues.`);
      }
    } catch (err) {
      notifyError(err, "Couldn't select all matching issues.");
    } finally {
      setSelectingAll(false);
    }
  }

  function bucketByProject(ids: string[]): Map<string, string[]> {
    const projectOf = new Map(rows.map((r) => [r.id, r.project.id]));
    // Off-page selections (from "select all matching") aren't in `rows` —
    // resolve their project from the captured match map instead of dropping them.
    const offPage = allMatchesRef.current;
    const buckets = new Map<string, string[]>();
    for (const id of ids) {
      const pid = projectOf.get(id) ?? offPage?.get(id)?.projectId;
      if (!pid) continue;
      const arr = buckets.get(pid);
      if (arr) arr.push(id);
      else buckets.set(pid, [id]);
    }
    return buckets;
  }

  async function bulkApply(update: Record<string, unknown>) {
    if (selectedCount === 0) return;
    setBulkPending(true);
    try {
      await Promise.all(
        [...bucketByProject(selectedIds).entries()].map(([projectId, ids]) =>
          jsonFetch(
            `/api/v1/orgs/${orgId}/projects/${projectId}/work-items/bulk`,
            { method: "PUT", body: JSON.stringify({ ids, update }) },
          ),
        ),
      );
      setRowSelection({});
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't apply the bulk change.");
    } finally {
      setBulkPending(false);
    }
  }

  // Tag add appends to each item's EXISTING tags, so bucket by project + the
  // current tag-set so every group's update carries the right resulting array.
  // Off-page selections (from "select all matching") aren't in `rows`, so their
  // tags come from the captured snapshot — otherwise a cross-page tag would
  // silently skip every item beyond the visible page (BR f6b52435).
  async function bulkAddTag(raw: string) {
    const tag = raw.trim();
    if (!tag || selectedCount === 0) return;
    setBulkPending(true);
    try {
      const currentPage = new Map(
        rows.map((r) => [r.id, { projectId: r.project.id, tags: r.tags }]),
      );
      const groups = planTagAddition(selectedIds, currentPage, allMatchesRef.current, tag);
      if (groups.length === 0) return;
      await Promise.all(
        groups.map((g) =>
          jsonFetch(
            `/api/v1/orgs/${orgId}/projects/${g.projectId}/work-items/bulk`,
            { method: "PUT", body: JSON.stringify({ ids: g.ids, update: { tags: g.tags } }) },
          ),
        ),
      );
      setRowSelection({});
      setTagDraft("");
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't add the tag.");
    } finally {
      setBulkPending(false);
    }
  }

  async function bulkDelete() {
    if (selectedCount === 0) return;
    setBulkPending(true);
    try {
      const buckets = [...bucketByProject(selectedIds).entries()];
      // Fan out one request per project, but SETTLE all of them: one project
      // failing must not abort the others — that left the reported "some items
      // vanished, others didn't, and the error says nothing" partial delete
      // (COSMOS-76). Every outcome is reconciled below.
      const settled = await Promise.allSettled(
        buckets.map(([projectId, ids]) =>
          jsonFetch(
            `/api/v1/orgs/${orgId}/projects/${projectId}/work-items/bulk`,
            { method: "DELETE", body: JSON.stringify({ ids }) },
          ),
        ),
      );
      const labelOf = new Map(rows.map((r) => [r.project.id, r.project.key]));
      const summary = summarizeBulkDelete(
        buckets.map(([projectId, ids], i) => {
          const outcome = settled[i];
          return outcome.status === "fulfilled"
            ? { projectId, ids, ok: true, projectLabel: labelOf.get(projectId) }
            : {
                projectId,
                ids,
                ok: false,
                projectLabel: labelOf.get(projectId),
                reason: reasonOf(outcome.reason),
              };
        }),
      );
      // Drop deleted rows from the selection but KEEP any that failed so the
      // user can retry just those. Always refetch so the table reflects what
      // actually got deleted, even on a partial failure.
      const stillFailing = new Set(summary.failedIds);
      setRowSelection((prev) => {
        const next: RowSelectionState = {};
        for (const id of Object.keys(prev)) {
          if (prev[id] && stillFailing.has(id)) next[id] = true;
        }
        return next;
      });
      await refetch();
      if (summary.errorMessage) {
        toast.error(summary.errorMessage);
      } else {
        setConfirmBulkDelete(false);
      }
    } catch (err) {
      notifyError(err, "Couldn't delete the selected items.");
    } finally {
      setBulkPending(false);
    }
  }
  const total = results?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

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
          // Scope the lane options to the item's OWN project — a global union
          // would let a user pick a status the item's board doesn't have, an
          // invalid transition the PUT can't reject (COSMOS-30).
          const projectStatuses = facets?.statusesByProject?.[row.original.project.id] ?? [];
          const status =
            projectStatuses.find((s) => s.key === row.original.columnKey) ??
            facets?.statuses.find((s) => s.key === row.original.columnKey);
          const variant = status ? STATUS_VARIANT[status.category] ?? "neutral" : "neutral";
          const display = (
            <Badge variant={variant}>{status?.name ?? row.original.columnKey}</Badge>
          );
          return (
            <InlineEditCell
              editable={canUpdateItem && projectStatuses.length > 0}
              label="status"
              value={row.original.columnKey}
              display={display}
              options={projectStatuses.map((s) => ({ value: s.key, label: s.name }))}
              onSelect={(v) =>
                void quickUpdate(
                  row.original,
                  { columnKey: v },
                  `status ${projectStatuses.find((s) => s.key === v)?.name ?? v}`,
                )
              }
            />
          );
        },
      },
      {
        accessorKey: "priority",
        header: "Priority",
        cell: ({ row }) => (
          <InlineEditCell
            editable={canUpdateItem}
            label="priority"
            value={row.original.priority}
            display={
              <Badge variant={PRIORITY_VARIANT[row.original.priority]}>
                {row.original.priority}
              </Badge>
            }
            options={(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((p) => ({
              value: p,
              label: p.charAt(0) + p.slice(1).toLowerCase(),
            }))}
            onSelect={(v) =>
              void quickUpdate(row.original, { priority: v }, `priority ${v.charAt(0) + v.slice(1).toLowerCase()}`)
            }
          />
        ),
      },
      {
        accessorKey: "assignee",
        header: "Assignee",
        cell: ({ row }) => {
          const a = row.original.assignee;
          // Multi-assign: stack up to three avatars, then a +N chip. The
          // primary keeps its name; extras surface via tooltips.
          const set = row.original.assignees ?? [];
          const extras = set.filter((x) => x.id !== a?.id);
          const display = a ? (
            <div className="flex items-center gap-2">
              <div className="flex -space-x-1.5">
                {[a, ...extras].slice(0, 3).map((u) => (
                  <Avatar key={u.id} className="h-6 w-6 ring-1 ring-[var(--surface)]" title={u.displayName}>
                    <AvatarImage src={u.avatarUrl ?? undefined} />
                    <AvatarFallback className="text-[10px]">
                      {u.displayName.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                ))}
              </div>
              <span className="text-sm">
                {a.displayName}
                {extras.length > 0 && (
                  <span className="ml-1 text-xs text-[var(--text-muted)]">+{extras.length}</span>
                )}
              </span>
            </div>
          ) : (
            <span className="text-sm text-[var(--text-muted)]">Unassigned</span>
          );
          return (
            <InlineEditCell
              editable={canUpdateItem && (facets?.members.length ?? 0) > 0}
              label="assignee"
              value={a?.id ?? ""}
              display={display}
              options={[
                { value: "", label: "Unassigned" },
                ...(facets?.members ?? []).map((m) => ({
                  value: m.id,
                  label: m.displayName,
                })),
              ]}
              onSelect={(v) =>
                void quickUpdate(
                  row.original,
                  { assigneeId: v || null },
                  v
                    ? `assigned ${facets?.members.find((m) => m.id === v)?.displayName ?? ""}`
                    : "unassigned",
                )
              }
            />
          );
        },
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
    [facets, canUpdateItem, quickUpdate],
  );

  // Per-row actions — surfaced by DataTable as a ⋯ column AND on right-click.
  const rowActions = useCallback(
    (r: IssueRow): ActionMenuGroup[] => {
      const boardHref = `/${orgSlug}/projects/${r.project.key}`;
      const itemBase = `/api/v1/orgs/${orgId}/projects/${r.project.id}/work-items/${r.id}`;
      const crud = [
        ...(canCreateItem
          ? [
              {
                // Open a pre-filled draft the user can edit before saving —
                // rather than immediately committing a copy (COSMOS-13). Saving
                // creates a distinct new issue; comments/activity/status aren't
                // carried over.
                label: "Duplicate",
                icon: Copy,
                onClick: () => {
                  setDuplicateSource({ itemId: r.id, projectId: r.project.id });
                  setCreateOpen(true);
                },
              },
            ]
          : []),
        ...(canBulkDelete
          ? [
              {
                label: "Delete",
                icon: Trash2,
                variant: "destructive" as const,
                onClick: async () => {
                  try {
                    await jsonFetch(itemBase, { method: "DELETE" });
                    toast.success("Issue deleted");
                    await refetch();
                  } catch (err) {
                    notifyError(err, "Couldn't delete the issue.");
                  }
                },
              },
            ]
          : []),
      ];
      // Quick "set priority" without opening the drawer (FR: more right-click /
      // 3-dot options + quick field changes). Universal across projects.
      const priorityGroup =
        canUpdateItem
          ? (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((p) => ({
              label: p.charAt(0) + p.slice(1).toLowerCase(),
              icon: Flag,
              onClick: async () => {
                if (r.priority === p) return;
                try {
                  await jsonFetch(itemBase, {
                    method: "PUT",
                    body: JSON.stringify({ priority: p }),
                  });
                  toast.success(`Priority set to ${p.toLowerCase()}`);
                  await refetch();
                } catch (err) {
                  notifyError(err, "Couldn't change the priority.");
                }
              },
            }))
          : [];
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
        ...(priorityGroup.length > 0 ? [{ label: "Set priority", items: priorityGroup }] : []),
        ...(crud.length > 0 ? [{ items: crud }] : []),
      ];
    },
    [orgSlug, orgId, router, canCreateItem, canBulkDelete, canUpdateItem, refetch],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        {/* Saved views (FR 2b36c2b8) — named, reusable filters. */}
        <SavedViewsPicker
          orgId={orgId}
          currentFilter={filterStateToSavedFilter(filters)}
          onApply={(wf) => {
            setFilters(savedFilterToFilterState(wf));
            setTextDraft(wf.text ?? "");
            setPage(1);
          }}
        />
        {/* Watching quick-filter (FR 8702c9b8) — restricts to items the current
            user follows (the ★ on a ticket's detail panel). */}
        <button
          type="button"
          onClick={() => set("watchedByMe", !filters.watchedByMe)}
          aria-pressed={filters.watchedByMe}
          className={cn(
            buttonVariants({ variant: filters.watchedByMe ? "default" : "outline", size: "sm" }),
            "gap-1.5",
          )}
          title="Show only the items you're watching"
        >
          <Star className={cn("h-4 w-4", filters.watchedByMe && "fill-current")} /> Watching
        </button>
        {/* Plain <a> (not Link): the route returns a Content-Disposition
            attachment, so this downloads the CSV without navigating away.
            `qs` carries the active filters → "export what you see". */}
        <a
          href={`/api/v1/orgs/${orgId}/work-items/export?${qs}`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
          title="Download these issues (your current filters applied) as a CSV"
        >
          <Download className="h-4 w-4" /> Export CSV
        </a>
      </div>
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
            <div className="flex items-center gap-2">
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
              {canCreateItem && (facets?.projects.length ?? 0) > 0 && (
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    setDuplicateSource(null);
                    setCreateOpen(true);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  New issue
                </Button>
              )}
            </div>
          </div>
          <DataTable
            columns={columns}
            data={rows}
            getRowId={(r) => r.id}
            onRowClick={(r) => setDetailRow(r)}
            rowActions={rowActions}
            {...(canBulkEdit || canBulkDelete
              ? { rowSelection, onRowSelectionChange: setRowSelection }
              : {})}
          />
          {total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-3 text-xs text-[var(--text-muted)]">
              <div className="flex items-center gap-2">
                <span>{total} issue{total === 1 ? "" : "s"}</span>
                <span aria-hidden>·</span>
                <label className="flex items-center gap-1">
                  Per page
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                    aria-label="Issues per page"
                    className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-xs text-[var(--text)] outline-none focus-visible:border-[var(--primary)]"
                  >
                    {[25, 50, 100, 200].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex items-center gap-2">
                <span>
                  Page {page} of {totalPages}
                </span>
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

      {selectedCount > 0 && (canBulkEdit || canBulkDelete) && (
        <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center px-4">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)]/95 px-3 py-2 shadow-lg ring-1 ring-foreground/10 supports-backdrop-filter:backdrop-blur">
            <span className="text-xs font-medium text-[var(--text)]">
              {selectedCount} selected
            </span>
            {selectedCount < total && (
              <button
                type="button"
                disabled={selectingAll}
                onClick={() => void selectAllMatching()}
                className="text-xs font-medium text-[var(--primary)] hover:underline disabled:opacity-60"
              >
                {selectingAll
                  ? "Selecting…"
                  : `Select all ${Math.min(total, SELECT_ALL_CAP).toLocaleString()} matching`}
              </button>
            )}
            <button
              type="button"
              onClick={() => setRowSelection({})}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              Clear
            </button>

            {canBulkEdit && (
              <>
                <span className="mx-1 h-5 w-px bg-[var(--border)]" aria-hidden />
                <BulkSelect
                  placeholder="Assign to"
                  ariaLabel="Assign selected items"
                  onValueChange={(v) =>
                    void bulkApply({ assigneeId: v === "__none" ? null : v })
                  }
                  options={[
                    { value: "__none", label: "Unassigned" },
                    ...(facets?.members ?? []).map((m) => ({
                      value: m.id,
                      label: m.displayName,
                    })),
                  ]}
                />
                <BulkSelect
                  placeholder="Priority"
                  ariaLabel="Set priority for selected items"
                  onValueChange={(v) => void bulkApply({ priority: v })}
                  options={[
                    { value: "CRITICAL", label: "Critical" },
                    { value: "HIGH", label: "High" },
                    { value: "MEDIUM", label: "Medium" },
                    { value: "LOW", label: "Low" },
                  ]}
                />
                <form
                  className="flex items-center"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void bulkAddTag(tagDraft);
                  }}
                >
                  <input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    placeholder="Add tag"
                    aria-label="Add tag to selected items"
                    disabled={bulkPending}
                    className="h-7 w-24 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </form>
              </>
            )}

            {canBulkDelete && (
              <>
                <span className="mx-1 h-5 w-px bg-[var(--border)]" aria-hidden />
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={bulkPending}
                  onClick={() => setConfirmBulkDelete(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={confirmBulkDelete}
        onOpenChange={(o) => {
          if (!o && !bulkPending) setConfirmBulkDelete(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {selectedCount} work item{selectedCount === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              This permanently deletes the selected work item
              {selectedCount === 1 ? "" : "s"} across their projects. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmBulkDelete(false)}
              disabled={bulkPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void bulkDelete()}
              disabled={bulkPending}
            >
              {bulkPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {canCreateItem && facets && (
        <CreateWorkItemDialog
          orgId={orgId}
          open={createOpen}
          onOpenChange={(next) => {
            setCreateOpen(next);
            // Drop the duplicate seed on close so the next plain "New issue"
            // opens blank (COSMOS-13).
            if (!next) setDuplicateSource(null);
          }}
          projects={facets.projects.filter((p) => !p.archived)}
          prefilledProjectId={
            duplicateSource
              ? undefined
              : filters.project !== ANY
                ? filters.project
                : undefined
          }
          duplicateSource={duplicateSource}
          onCreated={() => void refetch()}
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

/** Action-style Select for the bulk toolbar: an always-empty controlled value
 *  so the trigger stays a placeholder label and the same bulk action can be
 *  re-applied (mirrors the table view's BulkSelect). */
function BulkSelect({
  placeholder,
  ariaLabel,
  options,
  onValueChange,
}: {
  placeholder: string;
  ariaLabel: string;
  options: { value: string; label: string }[];
  onValueChange: (value: string) => void;
}) {
  return (
    <Select
      value=""
      onValueChange={(v) => {
        if (v) onValueChange(v as string);
      }}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel} className="h-7 text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
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

/**
 * A read-only display that becomes a click-to-edit dropdown when the actor can
 * update items. Clicking the cell opens a small menu of options; picking one
 * fires onSelect. stopPropagation keeps the row's detail drawer from opening.
 */
function InlineEditCell({
  value,
  display,
  options,
  onSelect,
  editable,
  label,
}: {
  value: string;
  display: React.ReactNode;
  options: { value: string; label: React.ReactNode }[];
  onSelect: (v: string) => void;
  editable: boolean;
  label: string;
}) {
  if (!editable) return <>{display}</>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Change ${label}`}
            onClick={(e) => e.stopPropagation()}
            className="-mx-1 rounded px-1 py-0.5 text-left transition-colors hover:bg-[var(--primary-tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {display}
          </button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-[160px]">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            onClick={(e) => {
              e.stopPropagation();
              if (o.value !== value) onSelect(o.value);
            }}
          >
            <Check
              className={cn(
                "h-3.5 w-3.5",
                o.value === value ? "opacity-100" : "opacity-0",
              )}
            />
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
