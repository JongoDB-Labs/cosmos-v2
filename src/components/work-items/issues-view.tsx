"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { jsonFetch, FetchError } from "@/lib/query/json-fetcher";
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
import type { ActionMenuGroup, ActionMenuItem } from "@/components/ui/action-menu";
import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import { WorkItemTypeIcon } from "@/components/work-items/work-item-type-icon";
import type { WorkItem, OrgMember, Interval, BoardColumn } from "@/types/models";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";
import { CQL_VERSION, type CqlQuery } from "@/lib/query/ast";
import { planTagAddition, type TagRowInfo } from "@/lib/work-items/bulk-tags";
import { summarizeBulkDelete } from "@/lib/work-items/bulk-delete";
import { ListFilter, Save, Eye, ExternalLink, Link2, Trash2, Copy, Flag, Highlighter, Plus, Check, Download, Star, Archive, UserPlus, CheckCircle2, CalendarRange } from "lucide-react";
import { highlightMenuGroup } from "@/lib/work-items/highlight-menu";
import { archiveAction } from "@/lib/work-items/item-actions";
import { highlightLabel, highlightRowStyle } from "@/lib/work-items/highlights";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { notifyError } from "@/lib/errors/notify";
import { sendItemChange, TransitionBackedOut, useTransitionPrompt } from "@/components/work-items/use-transition-prompt";
import { announceBulkChange, combineBulkChanges, sendBulkChange } from "@/components/work-items/bulk-change";
import { toast } from "sonner";
import { entityUrl } from "@/lib/mentions/urls";
import { useProjectTeams } from "@/hooks/use-project-teams";
import {
  ANY,
  EMPTY_FILTERS,
  FilterBar,
  STRING_FILTER_KEYS,
  filterStateToSavedFilter,
  savedFilterToFilterState,
  toQueryString,
  toWorkItemFilter,
  type Facets,
  type FilterState,
} from "@/components/work-items/issues-filter-bar";
import { QueryBuilder, withClause } from "@/components/work-items/cql/query-builder";
import { useCqlSchema, useCqlUrlState, useCqlValidate, viewerTimeZone } from "@/components/work-items/cql/use-cql";
import { FiltersMenu } from "@/components/work-items/cql/filters-menu";
import { SaveFilterDialog } from "@/components/work-items/cql/save-filter-dialog";
import { SubscribeDialog } from "@/components/work-items/cql/subscribe-dialog";
import { FilterChangedBar, filterChanged } from "@/components/work-items/cql/filter-changed-bar";
import { rememberFilter, useSavedFilter, type SavedFilter } from "@/components/work-items/cql/use-saved-filters";
import { toWorkItemFilter as cqlToWorkItemFilter } from "@/lib/query/adapters";
import { ARCHIVED_ONLY, WATCHING, hasClause, legacyText, toggleClause } from "@/lib/query/chip-ops";
import { parseCql } from "@/lib/query/parser";

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
  /** Who created it. Always sent; optional here because no column reads it yet. */
  reporter?: { id: string; displayName: string; avatarUrl: string | null } | null;
  parent: { id: string; ticketKey: string; title: string } | null;
  intervalId: string | null;
  storyPoints: number | null;
  tags: string[];
  /** Meeting callout colour. Mirrors `IssueRow` in
   *  `@/lib/work-items/query/project` — that file's Prisma `select` has to
   *  carry it too, and tsc cannot check that it does. */
  highlight: string | null;
  /** Archived (out of the way, not deleted); null when active. */
  archivedAt: string | null;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SearchResponse {
  data: IssueRow[];
  total: number;
}

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
  // A bulk move the workflow wants details for, asked once per transition.
  const { ask: askTransition, dialog: transitionDialog } = useTransitionPrompt();
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
  // Deep-link plumbing: the id already handled (so stripping the param can't
  // re-trigger a fetch) and the message shown when the link can't be opened.
  const handledDeepLinkRef = useRef<string | null>(null);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [bulkPending, setBulkPending] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── CQL, where the org has it on ─────────────────────────────────────────
  // One query in the URL (`?cql=`) drives the results, "select all matching",
  // the export, saved views and "Save as board". Orgs without it keep the
  // legacy filter bar (issues-filter-bar.tsx); the two never mix.
  const cqlSchema = useCqlSchema(orgId);
  const cqlOn = cqlSchema.enabled;
  const cqlUrl = useCqlUrlState();
  // A saved filter loaded with `?filter=<id>` runs BY ID until its text is
  // changed: the server runs the stored query, narrowed to what this viewer
  // can see, so even a filter with ‹restricted› parts runs correctly.
  const loadedFilter = useSavedFilter(orgId, cqlOn ? cqlUrl.filterId : null);
  const typed = cqlOn ? cqlUrl.cql : "";
  const runById = cqlOn && !!cqlUrl.filterId && !typed.trim();
  const cqlText = typed.trim() ? typed : runById ? (loadedFilter.data?.cql ?? "") : "";
  const restrictedFilter = runById && !!loadedFilter.data?.partiallyRestricted;
  const cqlValidation = useCqlValidate(orgId, cqlText, cqlOn && !restrictedFilter);
  const [saveDialog, setSaveDialog] = useState<{ cql: string } | { filter: SavedFilter } | null>(null);
  const [subscribeTo, setSubscribeTo] = useState<SavedFilter | null>(null);
  const cqlQuery = useMemo(() => parseCql(cqlText).query, [cqlText]);
  const applyCql = useCallback(
    (text: string) => {
      setPage(1);
      // Emptying the query also lets go of a loaded filter.
      cqlUrl.update(text.trim() ? { cql: text } : { cql: null, filter: null });
    },
    [cqlUrl],
  );
  const runSavedFilter = useCallback(
    (f: { id: string }) => {
      setPage(1);
      rememberFilter(f.id);
      cqlUrl.update({ filter: f.id, cql: null });
    },
    [cqlUrl],
  );
  const cfTypes = useMemo(
    () => new Map((cqlSchema.schema?.customFields ?? []).map((c) => [c.key, c.fieldType as string])),
    [cqlSchema.schema],
  );
  // The query in the legacy shape saved views and boards still store (until
  // saved filters v2), or null when that shape can't say it.
  const cqlFilter = useMemo((): WorkItemFilter | null => {
    if (!cqlOn) return null;
    if (!cqlText.trim()) return {};
    const v = cqlValidation.data;
    return v?.valid && v.query ? cqlToWorkItemFilter(legacyText(v.query), cfTypes) : null;
  }, [cqlOn, cqlText, cqlValidation.data, cfTypes]);
  // A board stores the resolved query itself (config.query), so any valid query
  // can become one.
  const boardQuery = useMemo((): CqlQuery | undefined => {
    if (!cqlOn) return undefined;
    if (!cqlText.trim()) return { v: CQL_VERSION, where: null };
    const v = cqlValidation.data;
    return v?.valid && v.query ? v.query : undefined;
  }, [cqlOn, cqlText, cqlValidation.data]);
  const boardUnavailable = cqlOn && !boardQuery
    ? restrictedFilter
      ? "This filter names things you can't see, so it can't become a board. Save it as a new filter first."
      : cqlValidation.isFetching
        ? "Checking the query…"
        : "Fix the query first."
    : undefined;

  // Deep-link: `/issues?watching=1` pre-applies the Watching filter (the "My
  // watched items" widget's "View all"). One-time init, then strip the param.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!searchParams.get("watching") || cqlSchema.isLoading) return;
    if (cqlOn) {
      // `?watching=1` (the "My watched items" widget) is `watcher = me`.
      cqlUrl.update({
        watching: null,
        cql: withClause(cqlUrl.cql, (q) => (hasClause(q, WATCHING) ? q : toggleClause(q, WATCHING))),
      });
      return;
    }
    setFilters((prev) => (prev.watchedByMe ? prev : { ...prev, watchedByMe: true }));
    const url = new URL(window.location.href);
    url.searchParams.delete("watching");
    router.replace(url.pathname + url.search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cqlSchema.isLoading]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Deep-link: `/issues?item=<id>` opens that work item's detail sheet even when
  // it isn't on the current page (mention chips / "Mentioned in" backlinks link
  // here). Fetch the single row (RBAC-scoped), open the sheet, then strip the
  // param so closing it doesn't re-open and the URL stays clean.
  useEffect(() => {
    const itemId = searchParams.get("item");
    if (!itemId || handledDeepLinkRef.current === itemId) return;
    // Remember the id BEFORE fetching. The param strip below re-runs this effect
    // (searchParams is a dependency), and this guard — rather than a `cancelled`
    // flag — is what stops a second fetch. The old code stripped the param
    // synchronously and cancelled on cleanup, so the re-run's cleanup fired
    // while the first fetch was still in flight and its result was thrown away:
    // the sheet never opened, for items that existed perfectly well. It only
    // ever worked if the fetch beat the router, which it usually didn't.
    handledDeepLinkRef.current = itemId;

    jsonFetch<IssueRow>(`/api/v1/orgs/${orgId}/work-items/${itemId}/row`)
      .then((row) => {
        if (row) setDetailRow(row);
      })
      .catch((err) => {
        // Say something rather than silently dumping the user on the list.
        // 403 and 404 are deliberately worded the same: telling someone an item
        // exists but is denied to them leaks its existence.
        const status = err instanceof FetchError ? err.status : 0;
        setDeepLinkError(
          status === 404 || status === 403
            ? "That issue no longer exists, or you don't have access to it."
            : "Couldn't open that issue. Check your connection and try the link again.",
        );
      })
      .finally(() => {
        // Strip AFTER the round trip, so closing the sheet doesn't re-open it
        // and the URL stays clean — but the fetch is never cut short.
        const url = new URL(window.location.href);
        url.searchParams.delete("item");
        router.replace(url.pathname + url.search);
        // Then release the guard, so navigating to the SAME id again actually
        // retries. Leaving it set made a second visit to one ticket — two
        // mention chips pointing at it, or acting on the error dialog's "try the
        // link again" — return early: no sheet, no dialog, and the param never
        // stripped. Safe to clear here: the strip above has already emptied
        // `item`, so the re-run this triggers exits at the guard above.
        handledDeepLinkRef.current = null;
      });
  }, [searchParams, orgId, router]);

  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const activeCount = useMemo(
    () =>
      (Object.keys(filters) as (keyof FilterState)[]).filter((k) => {
        if (k === "watchedByMe") return filters.watchedByMe;
        if (k === "showArchived") return filters.showArchived;
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

  /** The search query string for a page: the legacy filters, or `cql=` (+ the viewer's zone). */
  const searchQs = (p: number, size: number): string => {
    if (!cqlOn) return toQueryString(filters, p, size);
    const sp = new URLSearchParams();
    if (typed.trim()) sp.set("cql", typed);
    else if (runById) sp.set("filter", cqlUrl.filterId!);
    if (sp.size) sp.set("tz", viewerTimeZone());
    sp.set("page", String(p));
    sp.set("pageSize", String(size));
    return sp.toString();
  };
  const qs = searchQs(page, pageSize);
  const resultsKey = useOrgQueryKey("issues", "search", qs);
  const {
    data: results,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: resultsError,
  } = useQuery({
    queryKey: resultsKey,
    queryFn: () =>
      jsonFetch<SearchResponse>(`/api/v1/orgs/${orgId}/work-items/search?${qs}`),
    placeholderData: keepPreviousData,
    // Wait for the flag, so a CQL org doesn't first run the legacy search.
    enabled: !cqlSchema.isLoading,
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
        await sendItemChange(`/api/v1/orgs/${orgId}/projects/${row.project.id}/work-items/${row.id}`, patch, askTransition);
        toast.success(`${row.ticketKey} · ${label}`);
        void refetch();
      } catch (err) {
        if (!(err instanceof TransitionBackedOut)) notifyError(err, "Couldn't update the issue.");
      }
    },
    [orgId, refetch, askTransition],
  );

  const facets = facetsQuery.data;


  // The rows in this table are SUMMARIES; the editing sheet needs the whole work
  // item (children, custom fields, assignees…). Fetch it when a row is opened.
  const [detailItem, setDetailItem] = useState<WorkItem | null>(null);
  useEffect(() => {
    if (!detailRow) return;
    let cancelled = false;
    jsonFetch<WorkItem>(
      `/api/v1/orgs/${orgId}/projects/${detailRow.project.id}/work-items/${detailRow.id}`,
    )
      .then((full) => {
        if (!cancelled) setDetailItem(full);
      })
      .catch(() => {
        /* not readable / gone — the sheet stays empty rather than half-filled */
      });
    return () => {
      cancelled = true;
    };
  }, [detailRow, orgId]);

  // Per-project context for the sheet, derived from facets already loaded for
  // the filter bar — no extra round-trip just to open a ticket.
  const detailColumns: BoardColumn[] = useMemo(
    () =>
      (detailRow ? (facets?.statusesByProject?.[detailRow.project.id] ?? []) : []).map(
        (c, i) =>
          ({
            id: c.key,
            key: c.key,
            name: c.name,
            category: c.category,
            sortOrder: i,
          }) as unknown as BoardColumn,
      ),
    [detailRow, facets],
  );
  // The Team picker on the detail sheet (COSMOS-204).
  const { data: detailTeams } = useProjectTeams(orgId, detailRow?.project.id ?? "");
  const detailIntervals: Interval[] = useMemo(
    () =>
      (facets?.intervals ?? [])
        .filter((iv) => detailRow && iv.projectId === detailRow.project.id)
        .map((iv) => iv as unknown as Interval),
    [detailRow, facets],
  );
  const detailMembers: OrgMember[] = useMemo(
    () =>
      (facets?.members ?? []).map(
        (m) =>
          ({
            id: m.id,
            userId: m.id,
            user: { id: m.id, displayName: m.displayName, avatarUrl: m.avatarUrl },
          }) as unknown as OrgMember,
      ),
    [facets],
  );

  // Show "Save as board" to org board-creators AND to project managers (who can
  // create boards for the projects they manage, per the board POST's inheritance).
  const managedProjectIds = facets?.managedProjectIds ?? [];
  const canCreateBoard = hasOrgBoardCreate || managedProjectIds.length > 0;
  const rows = results?.data ?? [];

  // ── Bulk edit (cross-project) ───────────────────────────────────────────
  // Issues rows span projects, but the bulk API is per-project — so we bucket
  // the selected ids by their project and fan out one request per project. We
  // only expose project-AGNOSTIC ops here (assignee/priority/tags/delete);
  // status + interval are project-scoped and stay in the per-project table view.
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
          `/api/v1/orgs/${orgId}/work-items/search?${searchQs(p, MAX_SEARCH_PAGE)}`,
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
      // One project at a time: a transition that wants details asks once per project.
      const results = [];
      for (const [projectId, ids] of bucketByProject(selectedIds)) {
        results.push(
          await sendBulkChange({ basePath: `/api/v1/orgs/${orgId}/projects/${projectId}`, ids, update, ask: askTransition }),
        );
      }
      announceBulkChange(combineBulkChanges(results));
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
      notifyError(err, "Couldn't add the label.");
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
            <WorkItemTypeIcon
              icon={row.original.type.icon}
              color={row.original.type.color}
            />
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
      // The PROJECT, which redirects to whichever board you land on by default
      // — your per-project preference, else the project's. Deliberately NOT
      // "the item's board": a work item carries a `columnKey`, not a board, so
      // it appears on every board of the project with a matching column. There
      // is no single board that holds this row, which is why the menu entry
      // names the project instead of promising one.
      const projectBoardHref = `/${orgSlug}/projects/${r.project.key}`;
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
      // Quick field changes without opening the drawer (FR: more right-click /
      // 3-dot options). Each PUTs one field and refetches.
      //
      // Every option list below comes from `facets`, which the view has already
      // loaded — so the menu adds no fetch of its own and opens instantly.
      // Status and interval are read PER PROJECT: an Issues row can belong to
      // any project, and offering another project's sprints or columns would
      // produce a change the server rejects (or worse, silently accepts).
      const patch = async (body: Record<string, unknown>, done: string, fail: string) => {
        try {
          await sendItemChange(itemBase, body, askTransition);
          toast.success(done);
          await refetch();
        } catch (err) {
          if (!(err instanceof TransitionBackedOut)) notifyError(err, fail);
        }
      };

      const quick: ActionMenuItem[] = canUpdateItem
        ? [
            {
              label: "Assign to",
              icon: UserPlus,
              submenu: [
                {
                  label: "Unassigned",
                  checked: !r.assignee,
                  onClick: () =>
                    patch({ assigneeId: null }, "Unassigned", "Couldn't change the assignee."),
                },
                ...(facets?.members ?? []).map((m) => ({
                  label: m.displayName,
                  checked: r.assignee?.id === m.id,
                  onClick: () =>
                    patch(
                      { assigneeId: m.id },
                      `Assigned to ${m.displayName}`,
                      "Couldn't change the assignee.",
                    ),
                })),
              ],
            },
            {
              label: "Set status",
              icon: CheckCircle2,
              submenu: (facets?.statusesByProject?.[r.project.id] ?? []).map((s) => ({
                label: s.name,
                checked: r.columnKey === s.key,
                onClick: () =>
                  patch({ columnKey: s.key }, `Moved to ${s.name}`, "Couldn't change the status."),
              })),
            },
            {
              label: "Move to interval",
              icon: CalendarRange,
              submenu: [
                {
                  label: "No interval",
                  checked: !r.intervalId,
                  onClick: () =>
                    patch(
                      { intervalId: null },
                      "Removed from interval",
                      "Couldn't change the interval.",
                    ),
                },
                ...(facets?.intervals ?? [])
                  .filter((c) => c.projectId === r.project.id)
                  .map((c) => ({
                    label: c.name,
                    checked: r.intervalId === c.id,
                    onClick: () =>
                      patch(
                        { intervalId: c.id },
                        `Moved to ${c.name}`,
                        "Couldn't change the interval.",
                      ),
                  })),
              ],
            },
            {
              label: "Set priority",
              icon: Flag,
              submenu: (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((p) => ({
                label: p.charAt(0) + p.slice(1).toLowerCase(),
                checked: r.priority === p,
                onClick: () =>
                  patch(
                    { priority: p },
                    `Priority set to ${p.toLowerCase()}`,
                    "Couldn't change the priority.",
                  ),
              })),
            },
            ...archiveAction({
              item: r,
              canEdit: canUpdateItem,
              onToggle: (next) =>
                patch(
                  { archivedAt: next },
                  next ? "Archived" : "Restored from archive",
                  next ? "Couldn't archive that item." : "Couldn't restore that item.",
                ),
            }),
            {
              label: "Highlight",
              icon: Highlighter,
              // Nested, like the other quick field changes on this menu, rather
              // than a top-level group: this row menu already carries three
              // groups and flattening six colours into it would bury them.
              submenu: highlightMenuGroup({
                current: r.highlight,
                onPick: (next) =>
                  patch(
                    { highlight: next },
                    next
                      ? `Highlighted ${highlightLabel(next)!.toLowerCase()}`
                      : "Highlight cleared",
                    "Couldn't save the highlight.",
                  ),
              }).items,
            },
          ]
        : [];

      return [
        {
          items: [
            { label: "View details", icon: Eye, onClick: () => setDetailRow(r) },
            {
              label: "Open project board",
              icon: ExternalLink,
              onClick: () => router.push(projectBoardHref),
            },
            {
              label: "Copy link",
              icon: Link2,
              onClick: () => {
                // The ISSUE, not the project it belongs to. This used to copy
                // the project href — so pasting it dropped the recipient on the
                // project with no indication which ticket was meant, the
                // opposite of what "copy link" on a specific row promises.
                //
                // `entityUrl` is the shared builder the mention chips, home
                // widgets and dependency map already use, so every deep link in
                // the product has one definition. The issues view honours
                // `?item=` by opening that item's detail sheet.
                // The ticket KEY, not the uuid — a link that says which
                // ticket it points at before anyone clicks it. `/row` resolves
                // either, so older uuid links keep working.
                const href = entityUrl("workItem", {
                  orgSlug,
                  id: r.ticketKey?.trim() || r.id,
                });
                if (!href) return;
                try {
                  void navigator.clipboard?.writeText(`${window.location.origin}${href}`);
                  toast.success("Issue link copied");
                } catch {
                  /* clipboard unavailable */
                }
              },
            },
          ],
        },
        ...(quick.length > 0 ? [{ items: quick }] : []),
        ...(crud.length > 0 ? [{ items: crud }] : []),
      ];
    },
    [orgSlug, orgId, router, canCreateItem, canBulkDelete, canUpdateItem, refetch, facets, askTransition],
  );

  const watching = cqlOn ? hasClause(cqlQuery, WATCHING) : filters.watchedByMe;
  const archivedOnly = cqlOn ? hasClause(cqlQuery, ARCHIVED_ONLY) : filters.showArchived;
  const filtering = cqlOn ? cqlText.trim() !== "" || runById : activeCount > 0;
  // A query the server refused (400) is the query's fault, not the network's.
  const queryRejected = cqlOn && resultsError instanceof FetchError && resultsError.status === 400;
  // The project the view is pinned to, if exactly one: new issues and boards default to it.
  const pinnedProject = cqlOn
    ? cqlFilter?.projectIds?.length === 1
      ? cqlFilter.projectIds[0]
      : undefined
    : filters.project !== ANY
      ? filters.project
      : undefined;
  const exportQs = (() => {
    if (!cqlOn) return qs;
    const sp = new URLSearchParams();
    if (typed.trim()) sp.set("cql", typed);
    else if (runById) sp.set("filter", cqlUrl.filterId!);
    if (sp.size) sp.set("tz", viewerTimeZone());
    return sp.toString();
  })();

  return (
    <div className="space-y-4">
      {transitionDialog}
      <div className="flex items-center justify-end gap-2">
        {/* Saved views (FR 2b36c2b8) — named, reusable filters. */}
        {cqlOn ? (
          <>
            <FiltersMenu
              orgId={orgId}
              orgSlug={orgSlug}
              activeId={cqlUrl.filterId}
              onRun={runSavedFilter}
              onEdit={(f) => setSaveDialog({ filter: f })}
              onSubscribe={setSubscribeTo}
            />
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setSaveDialog({ cql: cqlText })}>
              <Save className="h-3.5 w-3.5" aria-hidden />
              Save filter
            </Button>
          </>
        ) : (
        <SavedViewsPicker
          orgId={orgId}
          currentFilter={filterStateToSavedFilter(filters)}
          onApply={(wf) => {
            setFilters(savedFilterToFilterState(wf));
            setTextDraft(wf.text ?? "");
            setPage(1);
          }}
        />
        )}
        {/* Watching quick-filter (FR 8702c9b8) — restricts to items the current
            user follows (the ★ on a ticket's detail panel). */}
        <button
          type="button"
          onClick={() =>
            cqlOn
              ? applyCql(withClause(cqlText, (q) => toggleClause(q, WATCHING)))
              : set("watchedByMe", !filters.watchedByMe)
          }
          aria-pressed={watching}
          className={cn(
            buttonVariants({ variant: watching ? "default" : "outline", size: "sm" }),
            "gap-1.5",
          )}
          title="Show only the items you're watching"
        >
          <Star className={cn("h-4 w-4", watching && "fill-current")} /> Watching
        </button>
        {/* Archived items are hidden everywhere else. This is the one place
            they can be brought back into view — which is how somebody finds the
            thing they archived by mistake and restores it. */}
        <button
          type="button"
          onClick={() =>
            cqlOn
              ? applyCql(withClause(cqlText, (q) => toggleClause(q, ARCHIVED_ONLY)))
              : set("showArchived", !filters.showArchived)
          }
          aria-pressed={archivedOnly}
          className={cn(
            buttonVariants({ variant: archivedOnly ? "default" : "outline", size: "sm" }),
            "gap-1.5",
          )}
          title="Show only archived items"
        >
          <Archive className="h-4 w-4" /> Archived
        </button>
        {/* Plain <a> (not Link): the route returns a Content-Disposition
            attachment, so this downloads the CSV without navigating away.
            `qs` carries the active filters → "export what you see". */}
        <a
          href={`/api/v1/orgs/${orgId}/work-items/export?${exportQs}`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
          title="Download these issues (your current filters applied) as a CSV"
        >
          <Download className="h-4 w-4" /> Export CSV
        </a>
      </div>
      {cqlSchema.isLoading ? (
        <Skeleton className="h-[58px] w-full rounded-[var(--radius)]" />
      ) : cqlOn && cqlSchema.schema ? (
        <QueryBuilder
          orgId={orgId}
          schema={cqlSchema.schema}
          cql={cqlText}
          onCqlChange={applyCql}
          mode={cqlUrl.mode}
          onModeChange={cqlUrl.setMode}
          serverDiagnostics={cqlValidation.data?.diagnostics ?? []}
        />
      ) : (
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
      )}
      {cqlOn && loadedFilter.data && filterChanged(typed, loadedFilter.data) && (
        <FilterChangedBar
          orgId={orgId}
          loaded={loadedFilter.data}
          cql={typed}
          onSaveAs={() => setSaveDialog({ cql: typed })}
          onDiscard={() => cqlUrl.update({ cql: null })}
        />
      )}
      {runById && (loadedFilter.isError || loadedFilter.data?.partiallyRestricted) && (
        <p role="status" className="text-xs text-[var(--text-muted)]">
          {loadedFilter.isError
            ? "That saved filter doesn't exist, or isn't shared with you."
            : (loadedFilter.data?.broken ?? `Parts of “${loadedFilter.data?.name}” refer to things you can't see. They're left out of the results.`)}
        </p>
      )}

      {isError ? (
        <LoadError
          title="Couldn't load issues"
          description={
            queryRejected
              ? "This query can't run as written. The problems are listed under the query."
              : "Something went wrong while running your search."
          }
          onRetry={() => void refetch()}
        />
      ) : isLoading || cqlSchema.isLoading ? (
        <TableSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          illustration={<ListFilter className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden />}
          title={filtering ? "No issues match these filters" : "No issues yet"}
          description={
            filtering
              ? "Try widening or clearing some filters."
              : "Work items across your projects will show up here."
          }
          action={
            filtering ? (
              <Button
                variant="outline"
                onClick={() => {
                  if (cqlOn) {
                    applyCql("");
                    return;
                  }
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
                  disabled={!!boardUnavailable}
                  title={boardUnavailable}
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
            rowStyle={(r) => highlightRowStyle(r.highlight)}
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

      {/* The SAME editing sheet the boards use. The Issues page previously had
          its own read-only sheet, so anyone who created an issue here had to go
          find it on a board to change anything. Two sheets also meant every new
          field had to be built twice, and the read-only one always lagged. */}
      <CardDetailSheet
        item={detailItem}
        open={detailRow !== null}
        onOpenChange={(o) => {
          if (!o) {
            setDetailRow(null);
            setDetailItem(null);
          }
        }}
        orgId={orgId}
        projectId={detailRow?.project.id ?? ""}
        members={detailMembers}
        intervals={detailIntervals}
        teams={detailTeams}
        columns={detailColumns}
        onUpdate={(updated) => {
          setDetailItem(updated);
          void refetch();
        }}
        onDelete={() => {
          setDetailRow(null);
          setDetailItem(null);
          void refetch();
        }}
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
                    placeholder="Add label"
                    aria-label="Add label to selected items"
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

      {cqlOn && (
        <SubscribeDialog orgId={orgId} filter={subscribeTo} open={subscribeTo !== null} onOpenChange={(o) => !o && setSubscribeTo(null)} />
      )}
      {cqlOn && (
        <SaveFilterDialog
          orgId={orgId}
          open={saveDialog !== null}
          onOpenChange={(o) => !o && setSaveDialog(null)}
          filter={saveDialog && "filter" in saveDialog ? saveDialog.filter : undefined}
          cql={saveDialog && "cql" in saveDialog ? saveDialog.cql : undefined}
          projects={(facets?.projects ?? []).filter((p) => !p.archived)}
          members={facets?.members ?? []}
          onSaved={(f) => {
            // A new filter is loaded, so the "changed" bar tracks it from now on.
            if (saveDialog && "cql" in saveDialog) runSavedFilter(f);
          }}
        />
      )}

      {canCreateBoard && facets && (
        <SaveAsBoardDialog
          open={saveBoardOpen}
          onOpenChange={setSaveBoardOpen}
          orgId={orgId}
          orgSlug={orgSlug}
          filter={cqlOn ? (cqlFilter ? { ...cqlFilter, projectIds: undefined } : null) : toWorkItemFilter(filters)}
          query={boardQuery}
          projects={
            // A project manager without org-wide BOARD_CREATE may only target the
            // projects they manage — don't offer one whose POST would 403.
            hasOrgBoardCreate
              ? facets.projects
              : facets.projects.filter((p) => managedProjectIds.includes(p.id))
          }
          defaultProjectId={pinnedProject}
        />
      )}

      {/* A deep link that can't be opened (deleted issue, or one the viewer
          can't read) used to leave the user on the list with no explanation. */}
      <Dialog open={deepLinkError !== null} onOpenChange={(o) => !o && setDeepLinkError(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Can&rsquo;t open that issue</DialogTitle>
            <DialogDescription>{deepLinkError}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setDeepLinkError(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              : pinnedProject
          }
          duplicateSource={duplicateSource}
          onCreated={() => void refetch()}
        />
      )}
    </div>
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
