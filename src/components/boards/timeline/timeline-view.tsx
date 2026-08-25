"use client";

import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Route,
  Settings2,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Loader2,
  GitCompareArrows,
  Ban,
  EyeOff,
  Wrench,
  Waypoints,
  Undo2,
  Redo2,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { jsonFetch } from "@/lib/query/json-fetcher";
import {
  teamsByUser,
  itemMatchesTeam,
  type TeamLike,
} from "@/lib/teams/item-teams";
import { matchesLabelFilter, presentLabels } from "@/lib/work-items/label-filter";
import { matchesOneOf, matchesDuePreset } from "@/lib/work-items/metadata-filters";
import { matchesFilters } from "@/lib/work-items/board-filters";
import { blockersByItem, isBlockingLink } from "@/lib/work-items/blocking";
import {
  blockedItemIds,
  matchesBlocked,
  milestoneItemIds,
  matchesMilestone,
  presentStoryPoints,
  matchesStoryPoints,
} from "@/lib/work-items/relation-filters";
import { matchesEstimateBand, hasAnyEstimate } from "@/lib/work-items/estimate-filter";
import { useOrgQueryKey, useOrgSlug } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { cn } from "@/lib/utils";
import { buildTimelineTree } from "@/lib/boards/timeline-tree";
import { useProjectStatuses } from "@/hooks/use-project-statuses";
import { slipDays } from "@/lib/schedule/health";
import type { WorkItem, OrgMember, Interval, Board, BoardColumn, CustomField } from "@/types/models";
import {
  bareTypeKey,
  customFieldHasValue,
  FilterBar,
  emptyFilters,
  matchesCustomFieldFilters,
  type BoardFilters,
} from "@/components/boards/shared/filter-bar";
import { useCustomFields } from "@/hooks/use-custom-fields";
import { NewIssueButton } from "@/components/boards/shared/new-issue-button";
import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import { planDriftPhantoms, type DriftColor } from "@/lib/boards/plan-drift";
import { paintedSpan, solidSpan } from "@/lib/boards/timeline-span";

interface TimelineViewProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

/** A work-item dependency link as returned by the work-item-links endpoint. */
interface WorkItemLink {
  id: string;
  type: string;
  sourceItemId: string;
  targetItemId: string;
  sourceTicketNumber: number;
  targetTicketNumber: number;
  createdAt: string;
}

/**
 * Bar colour carries WHAT KIND OF WORK this is, in three bands — not the item's
 * health, and not one hue per type key. Five hues across five hardcoded keys
 * meant the catalogue's other ~50 types all fell through to one of them, and it
 * put green on the bars while green also meant "ahead of plan" on the drift
 * marks. Three bands keep the chart readable at a glance and leave green and red
 * to mean one thing each.
 */
type BarColors = { fill: string; stroke: string; text: string };

const BAND_COLORS = {
  /** The containers work is planned INTO. */
  initiative: { fill: "#8b5cf6", stroke: "#6d28d9", text: "text-purple-100" },
  /** The work itself — everything a team actually moves across a board. */
  delivery: { fill: "#3b82f6", stroke: "#1d4ed8", text: "text-blue-100" },
  /** A point in time rather than a span; drawn as a diamond, never a bar. */
  milestone: { fill: "#f97316", stroke: "#c2410c", text: "text-orange-100" },
} satisfies Record<string, BarColors>;

const TYPE_BAND: Record<string, keyof typeof BAND_COLORS> = {
  EPIC: "initiative",
  FEATURE: "initiative",
  STORY: "delivery",
  TASK: "delivery",
  SUBTASK: "delivery",
  BUG: "delivery",
  MILESTONE: "milestone",
};

/**
 * An item the chart knows NOTHING about in time: no plan, and nothing actually
 * started or finished.
 *
 * Bar geometry falls back to `createdAt -> createdAt + 7 days` when dates are
 * missing, which draws a perfectly ordinary week-long bar out of two values
 * nobody entered. On a board of imported work that is a wall of confident,
 * invented plans — and now that the create form REQUIRES planned dates, the
 * chart implies a plan exists for exactly the items that have none.
 *
 * `completedAt` alone still counts as knowing something, so it is not undated.
 */
function isUndatedItem(item: {
  startDate: string | null;
  dueDate: string | null;
  actualStart: string | null;
  completedAt: string | null;
}): boolean {
  return !item.startDate && !item.dueDate && !item.actualStart && !item.completedAt;
}

/** A dated point, not a span — either typed as a milestone or collapsed to one
 *  day. Both render as an orange diamond. */
function isMilestoneItem(item: {
  startDate: string | null;
  dueDate: string | null;
  workItemType?: { key: string } | null;
}): boolean {
  if (bareTypeKey(item.workItemType?.key) === "MILESTONE") return true;
  return Boolean(item.startDate && item.dueDate && item.startDate === item.dueDate);
}

/** Anything outside the two named bands is delivery work — the catalogue is far
 *  wider than the keys listed above, and blue is the honest default for it. */
function barColorsFor(typeKey: string | null | undefined, milestone: boolean): BarColors {
  if (milestone) return BAND_COLORS.milestone;
  return BAND_COLORS[TYPE_BAND[bareTypeKey(typeKey)] ?? "delivery"];
}

const ROW_HEIGHT = 40;
const HEADER_HEIGHT = 50;
// Day column width at 100% zoom. The rendered width is BASE_DAY_WIDTH * zoom —
// see `dayWidth` in the component, which every x/width computation reads.
type CriticalMode = "dependencies" | "duration" | "latest-finish" | "at-risk";
const CRITICAL_MODES: { key: CriticalMode; label: string; hint: string }[] = [
  { key: "dependencies", label: "Most dependencies", hint: "The chain with the most linked items" },
  { key: "duration", label: "Longest duration", hint: "The chain with the most days of work" },
  { key: "latest-finish", label: "Latest finish", hint: "The chain that sets the plan's end date" },
  { key: "at-risk", label: "Most at risk", hint: "The chain carrying the most overdue or blocked work" },
];

/** The selection gutter shared by the column header and every row, so the
 *  checkboxes read as one column of the work-items list rather than a control
 *  stuck on the front of each row. Sized in rem ON PURPOSE: the column's font
 *  scales with zoom, but a hit target that shrinks with it stops being clickable
 *  at 30% — and ROW_HEIGHT is already fixed for the same reason (the rows have
 *  to stay lined up with their bars). Matches the 36px control column
 *  `data-table.tsx` uses for its own selection cells. */
const SELECT_GUTTER = "flex w-7 shrink-0 items-center";

const BASE_DAY_WIDTH = 28;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.25;
/** Work-items column font scales with zoom so the two panes stay legible together. */
function labelScale(zoom: number): number {
  return Math.min(Math.max(zoom, 0.75), 1.4);
}

// ── Collapse-state persistence (FR COSMOS-69) ───────────────────────────────
// The per-parent expand/collapse state is kept in sessionStorage, keyed by
// board id, so it survives navigating away from the timeline and back within
// the same browser session (and a reload) — not just interactions on the live
// view. sessionStorage (per-tab, cleared when the tab closes) matches the
// "within the timeline session" scope: it's remembered while you work, not
// forever. All access is guarded so private mode / disabled storage / SSR just
// degrade to the previous ephemeral behavior.
const collapseStorageKey = (boardId: string) => `cosmos:timeline-collapsed:${boardId}`;

function readCollapsedIds(boardId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.sessionStorage.getItem(collapseStorageKey(boardId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsedIds(boardId: string, ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(collapseStorageKey(boardId), JSON.stringify([...ids]));
  } catch {
    /* private mode / disabled storage — collapse state stays ephemeral */
  }
}

/** A real milestone row (prisma Milestone), as the milestones API returns it. */
interface ProjectMilestone {
  id: string;
  title: string;
  dueDate?: string | null;
  status?: string;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function diffDays(a: Date, b: Date): number {
  const msPerDay = 86400000;
  return Math.round((b.getTime() - a.getTime()) / msPerDay);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The effective [start, end] a bar is drawn from — the SAME fallback the bar
 *  renderer uses (no startDate → createdAt; no dueDate → start + 7), so a drag
 *  computes against exactly what's on screen. */
function itemSpan(item: WorkItem): { start: Date; end: Date } {
  const start = item.startDate
    ? startOfDay(new Date(item.startDate))
    : startOfDay(new Date(item.createdAt));
  const end = item.dueDate ? startOfDay(new Date(item.dueDate)) : addDays(start, 7);
  return { start, end };
}

/** Two colours, one axis: ahead of plan, or behind it. */
const DRIFT_COLOR: Record<DriftColor, string> = {
  // A light, cool mint. It has to read over a bar as well as beside one, and it
  // must not be confused with the delivery blue underneath it.
  green: "#6ee7b7",
  red: "var(--status-critical)",
};

/**
 * ONE opacity for every phantom on the chart — the planned bar of un-started
 * work, and both drift marks that land on bare canvas. A phantom is the plan,
 * and the plan should read as the same kind of mark wherever it appears, so this
 * is deliberately a single constant rather than a value per element.
 *
 * Solid = actual, shadow = planned. That is the whole language.
 */
const PHANTOM_OPACITY = 0.45;

/**
 * Striped marks lie ON the solid bar, and the bar shows through the pattern's
 * gaps — so the transparency is in the hatch, not in the opacity. Fading these
 * too would wash out the stripes and lose the mark entirely.
 */
const STRIPE_OPACITY = 0.95;

type DragMode = "move" | "start" | "end";

/** Client-side board-filter match (search/type/priority/assignee/interval + custom
 *  fields) — mirrors the Kanban/Table logic so the Gantt's FilterBar behaves
 *  identically, including filtering by admin-defined custom fields. `defs` is the
 *  project's custom-field definitions (needed to interpret each active
 *  constraint's kind); an empty list makes the custom-field check inert. */

/** 0..1 completion for a bar's progress fill. A parent rolls up its children's
 *  done ratio; a leaf is complete (1) if it's completed or sits in a DONE column. */
function progressOf(item: WorkItem, doneKeys: Set<string>): number {
  const kids = item.children ?? [];
  if (kids.length > 0) {
    const done = kids.filter((k) => k.columnKey != null && doneKeys.has(k.columnKey)).length;
    return done / kids.length;
  }
  if (item.completedAt) return 1;
  return doneKeys.has(item.columnKey) ? 1 : 0;
}

/** A single Gantt analysis-lens toggle chip. Off = muted outline; on = tinted
 *  in the lens's accent color so several active lenses stay visually distinct. */
function LensToggle({
  active,
  onClick,
  icon,
  label,
  title,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  title: string;
  accent: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
        !active && "border-border hover:text-foreground",
      )}
      style={
        active
          ? { borderColor: accent, color: accent, backgroundColor: `color-mix(in srgb, ${accent} 12%, transparent)` }
          : undefined
      }
      data-active={active}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5",
          !active && "text-muted-foreground",
        )}
      >
        {icon} {label}
      </span>
    </button>
  );
}

export function TimelineView({ orgId, projectId, projectKey, boardId }: TimelineViewProps) {
  const [hoveredItem, setHoveredItem] = useState<WorkItem | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  // Same deep-link the Release Timeline uses (COSMOS-45): opening a milestone
  // lands on the one milestones surface, not a view-local editor.
  const orgSlug = useOrgSlug();
  const projectBase = `/${orgSlug}/projects/${projectKey}`;

  const qc = useQueryClient();
  const itemsKey = useOrgQueryKey("work-items", projectId);
  const teamsKey = useOrgQueryKey("project-teams", projectId);
  const membersKey = useOrgQueryKey("members");
  const linksKey = useOrgQueryKey("work-item-links", projectId);
  const boardKey = useOrgQueryKey("board", boardId);
  const intervalsKey = useOrgQueryKey("intervals", projectId);
  // The SAME key the Milestones board reads. A milestone is one row in one
  // table; this board renders it, it does not own a private notion of one.
  const milestonesKey = useOrgQueryKey("milestones", projectId);

  const [itemsQ, membersQ, linksQ, boardQ, intervalsQ, milestonesQ, teamsQ] = useQueries({
    queries: [
      {
        queryKey: itemsKey,
        queryFn: () => jsonFetch<WorkItem[]>(`${basePath}/work-items`),
      },
      {
        queryKey: membersKey,
        queryFn: () => jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`),
      },
      {
        // Dependency links (prod-parity): drives the Gantt dependency arrows.
        queryKey: linksKey,
        queryFn: () => jsonFetch<WorkItemLink[]>(`${basePath}/work-item-links`),
      },
      {
        // Board (for its columns) + intervals — needed so a bar click can open the
        // SAME CardDetailSheet the Kanban/Table views use (FR: card detail
        // reachable + editable from the Timeline too).
        queryKey: boardKey,
        queryFn: () => jsonFetch<Board>(`${basePath}/boards/${boardId}`),
      },
      {
        queryKey: intervalsKey,
        queryFn: () => jsonFetch<Interval[]>(`${basePath}/intervals`),
      },
      {
        // Real milestones. Before this the Gantt inferred one from a work item
        // whose start and due dates matched, which meant a milestone created
        // anywhere else was invisible here and the diamonds it DID draw were
        // not milestones at all — two datasets for one idea.
        queryKey: milestonesKey,
        queryFn: () => jsonFetch<ProjectMilestone[]>(`${basePath}/milestones`),
      },
      {
        // Teams + their rosters. A team's work is derived from who it is
        // assigned to, so the roster is what makes the Team filter possible.
        queryKey: teamsKey,
        queryFn: () =>
          jsonFetch<{ id: string; name: string; members: { userId: string }[] }[]>(
            `${basePath}/teams`,
          ),
      },
    ],
  });

  const items = useMemo<WorkItem[]>(() => itemsQ.data ?? [], [itemsQ.data]);
  // Distinct bare type keys present on this board — scopes the Type filter to
  // what's actually here (see FilterBar.presentTypeKeys).
  const presentTypeKeys = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) {
      if (it.workItemType?.key) s.add(bareTypeKey(it.workItemType.key));
    }
    return [...s];
  }, [items]);
  // Custom-field keys actually populated on this board — scopes the field
  // filters (see FilterBar.presentCustomFieldKeys).
  const presentCustomFieldKeys = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) {
      const cf = it.customFields;
      if (cf) {
        for (const [k, v] of Object.entries(cf)) {
          if (customFieldHasValue(v)) s.add(k);
        }
      }
    }
    return [...s];
  }, [items]);
  const members = useMemo<OrgMember[]>(() => membersQ.data ?? [], [membersQ.data]);
  const links = useMemo<WorkItemLink[]>(() => linksQ.data ?? [], [linksQ.data]);
  const columns = useMemo<BoardColumn[]>(() => boardQ.data?.columns ?? [], [boardQ.data]);
  // Status options come from the PROJECT's workflow, not this board's own
  // columns. A Timeline board owns none, so sourcing them here meant the Status
  // control never rendered — the reported "can't filter on status on Gantt".
  const projectStatuses = useProjectStatuses(orgId, projectId);
  const intervals = useMemo<Interval[]>(() => intervalsQ.data ?? [], [intervalsQ.data]);
  // Custom-field defs for this project (org-wide + project-scoped) — drives the
  // FilterBar's per-field controls and the client-side filter match below, so a
  // defined field is filterable on the Gantt exactly as it is on the Kanban board.
  const { fields: projectCustomFields } = useCustomFields(orgId, projectId);

  // ── Gantt controls ───────────────────────────────────────────────────────
  // FilterBar filters (search/type/priority/assignee/interval), a critical-path
  // highlight toggle, and a busy flag while a bulk shift/compress is in flight.
  const [filters, setFilters] = useState<BoardFilters>(emptyFilters);
  const teams: TeamLike[] = useMemo(() => teamsQ.data ?? [], [teamsQ.data]);
  const teamsByUserId = useMemo(() => teamsByUser(teams), [teams]);
  const presentLabelNames = useMemo(() => presentLabels(items), [items]);
  const filterNow = useMemo(() => new Date(), [items]);
  const blockedIds = useMemo(() => blockedItemIds(links), [links]);
  const blockers = useMemo(() => blockersByItem(links), [links]);
  const milestoneRows = useMemo(
    () => (milestonesQ.data as { id: string; title: string; links?: { workItemId: string }[] }[] | undefined) ?? [],
    [milestonesQ.data],
  );
  const milestoneMap = useMemo(() => milestoneItemIds(milestoneRows), [milestoneRows]);
  const presentPointValues = useMemo(() => presentStoryPoints(items), [items]);
  const showEstimate = useMemo(() => hasAnyEstimate(items), [items]);
  // Analysis "lenses" (FR gantt-enh) — a small set of overlay toggles the user
  // flips to read the schedule a particular way, replacing the lone Critical
  // path button: critical chain, planned-vs-actual baselines, enabler emphasis.
  const [showCritical, setShowCritical] = useState(false);
  const [criticalMode, setCriticalMode] = useState<CriticalMode>("dependencies");
  // Dim everything off the path rather than hiding it: the surrounding bars are
  // what make a path read as critical. Hiding them leaves a chain floating with
  // nothing to be critical RELATIVE to.
  const [criticalIsolate, setCriticalIsolate] = useState(true);
  const [showPlanDrift, setShowPlanDrift] = useState(false);
  const [showEnablers, setShowEnablers] = useState(false);
  // Zoom replaces the old Compress/Expand controls. Those MUTATED the schedule —
  // they rewrote every item's dates by a factor, which is a destructive way to
  // get a wider or narrower picture. Zoom changes only how the same dates are
  // DRAWN, so looking closer can no longer move anyone's plan.
  const [zoom, setZoom] = useState(1);
  const dayWidth = Math.round(BASE_DAY_WIDTH * zoom);
  const zoomBy = useCallback(
    (factor: number) =>
      setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor))),
    [],
  );
  // Fullscreen. The board tabs, the project header and the app sidebar are all
  // drawn by ANCESTORS of this view, so there is no prop it can set to get them
  // out of the way — claiming the viewport with a fixed overlay is the only way
  // a plan gets the whole screen. Zoom (and every other control's state) lives
  // in this component, so entering and leaving changes nothing but the layout.
  const [fullscreen, setFullscreen] = useState(false);
  const [showDeps, setShowDeps] = useState(false);
  // Blocked lens: red bars for impeded work, with arrows to whatever is holding
  // it up. Every dependency renders the same grey otherwise, so "what is stuck,
  // and behind what" is invisible on a board of any size.
  const [showBlocked, setShowBlocked] = useState(false);
  // Finished work still occupies rows. On a long-running plan it crowds out what
  // is actually in play.
  const [hideDone, setHideDone] = useState(false);
  const [busy, setBusy] = useState(false);

  // From the PROJECT's workflow, not this board's own columns. A Timeline board
  // owns no BoardColumn rows, so `columns` is empty here and doneKeys was always
  // empty with it — which silently made progressOf() report 0% for every bar and
  // gave the Hide-done lens nothing to hide. Same root cause as the Status
  // filter having no options on this board.
  const doneKeys = useMemo(
    () =>
      new Set(
        (projectStatuses.length > 0 ? projectStatuses : columns)
          .filter((c) => c.category === "DONE")
          .map((c) => c.key),
      ),
    [projectStatuses, columns],
  );

  const filteredItems = useMemo(
    () =>
      items.filter(
        (it) =>
          matchesFilters(it, filters, projectCustomFields, teamsByUserId, filterNow, {
            blocked: blockedIds,
            milestones: milestoneMap,
          }) &&
          // Hide-done lens. Finished work still occupies rows, and on a
          // long-running plan it crowds out what is actually in play.
          !(hideDone && it.columnKey != null && doneKeys.has(it.columnKey)),
      ),
    [items, filters, projectCustomFields, teamsByUserId, filterNow, blockedIds, milestoneMap, hideDone, doneKeys],
  );
  const hasEnablers = useMemo(
    () => filteredItems.some((it) => it.workCategory === "ENABLER"),
    [filteredItems],
  );

  // ── Hierarchy rows (FR f396a6a9) ─────────────────────────────────────────
  // Depth-first parent→children row order with per-parent collapse. Collapsing a
  // parent hides its whole subtree (rows, bars, and arrows all key off the row
  // list). A child whose parent is filtered out surfaces as a root so a filter
  // can never hide items silently. Ordering (roots by start date, sub-items by
  // their manual sortOrder — FR COSMOS-5) lives in `buildTimelineTree`.
  //
  // The collapse state is seeded from (and written back to) sessionStorage keyed
  // by board, so it persists across navigating away and back within the session
  // (FR COSMOS-69) rather than resetting every time the view mounts.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() =>
    readCollapsedIds(boardId),
  );
  // If this same view instance is reused for a different board (TIMELINE →
  // TIMELINE navigation reconciles rather than remounts), re-seed that board's
  // saved state instead of carrying the previous board's collapse set over.
  const boardRef = useRef(boardId);
  useEffect(() => {
    if (boardRef.current === boardId) return;
    boardRef.current = boardId;
    setCollapsedIds(readCollapsedIds(boardId));
  }, [boardId]);

  const fullTree = useMemo(
    () => buildTimelineTree(filteredItems, collapsedIds),
    [filteredItems, collapsedIds],
  );

  // When the Dependencies lens is on, focus on the interdependent set.
  const linkedIds = useMemo(() => {
    const set = new Set<string>();
    for (const l of links) {
      set.add(l.sourceItemId);
      set.add(l.targetItemId);
    }
    return set;
  }, [links]);

  // Dependencies view: keep the SAME epic/feature/story nesting as the normal
  // view, just restricted to the linked set. Include every linked item AND its
  // ancestor chain (ancestors are shown for structure even when not themselves
  // linked), then build the identical depth-first tree so nesting and collapse
  // behave exactly as when the lens is off — no more flat, depth-0 list.
  const depsTree = useMemo(() => {
    if (!showDeps) return { treeRows: [], parentIds: new Set<string>() };
    const byId = new Map(filteredItems.map((i) => [i.id, i]));
    const keep = new Set<string>();
    for (const it of filteredItems) {
      if (!linkedIds.has(it.id)) continue;
      keep.add(it.id);
      let pid = it.parentId;
      while (pid && byId.has(pid) && !keep.has(pid)) {
        keep.add(pid);
        pid = byId.get(pid)!.parentId;
      }
    }
    return buildTimelineTree(
      filteredItems.filter((it) => keep.has(it.id)),
      collapsedIds,
    );
  }, [showDeps, filteredItems, linkedIds, collapsedIds]);

  const { treeRows, parentIds } = showDeps ? depsTree : fullTree;
  const visibleRows = treeRows;

  // Apply a change to the collapse set and persist it in one step, so the
  // session-restored state always matches what's on screen.
  const commitCollapsed = useCallback(
    (next: Set<string>) => {
      writeCollapsedIds(boardId, next);
      setCollapsedIds(next);
    },
    [boardId],
  );

  const toggleCollapse = useCallback(
    (id: string) => {
      const next = new Set(collapsedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      commitCollapsed(next);
    },
    [collapsedIds, commitCollapsed],
  );

  // Click a bar → open the shared work-item detail (same as other board views).
  // Tracked by id + derived from the live items so edits/deletes stay in sync.
  const [detailId, setDetailId] = useState<string | null>(null);

  // Resizable Work Items column (persisted) — drag the handle on its right edge.
  const [nameColW, setNameColW] = useState<number>(() => {
    if (typeof window === "undefined") return 260;
    const n = Number(window.localStorage.getItem("gantt-name-col-w"));
    return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 160), 640) : 260;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("gantt-name-col-w", String(nameColW));
    } catch {
      /* ignore quota / private mode */
    }
  }, [nameColW]);
  const nameResizeRef = useRef<{ startX: number; startW: number } | null>(null);
  const onNameResizeDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      nameResizeRef.current = { startX: e.clientX, startW: nameColW };
    },
    [nameColW],
  );
  const onNameResizeMove = useCallback((e: React.PointerEvent) => {
    const d = nameResizeRef.current;
    if (!d) return;
    setNameColW(Math.min(Math.max(d.startW + (e.clientX - d.startX), 160), 640));
  }, []);
  const onNameResizeUp = useCallback(() => {
    nameResizeRef.current = null;
  }, []);
  const detailItem = detailId
    ? items.find((i) => i.id === detailId) ?? null
    : null;
  // A real drag (movement) also fires a trailing click — suppress it so a
  // reschedule/resize doesn't pop the detail sheet.
  const justDraggedRef = useRef(false);

  // Undo/redo for drag reschedules (the Gantt's mutating action). Each edit stores
  // the item's full before/after date range so undo/redo just re-commits a snapshot.
  type ScheduleEdit = {
    id: string;
    before: { startDate: string; dueDate: string };
    after: { startDate: string; dueDate: string };
  };
  const [undoStack, setUndoStack] = useState<ScheduleEdit[]>([]);
  const [redoStack, setRedoStack] = useState<ScheduleEdit[]>([]);
  const loading = itemsQ.isLoading || membersQ.isLoading;
  const error = itemsQ.error
    ? itemsQ.error instanceof Error
      ? itemsQ.error.message
      : "Unknown error"
    : null;

  const memberMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.userId, m.user?.displayName ?? m.user?.email ?? "Unknown");
    }
    return map;
  }, [members]);

  // Compute timeline range. The range spans ALL filtered items (collapsed
  // subtrees included) so collapsing never reflows the axis; row ORDER comes
  // from the hierarchy walk above.
  const { timelineStart, totalDays } = useMemo(() => {
    if (filteredItems.length === 0) {
      const now = startOfDay(new Date());
      return { timelineStart: addDays(now, -7), totalDays: 37 };
    }

    const now = new Date();
    let minDate = now;
    let maxDate = now;

    for (const item of filteredItems) {
      // The axis has to cover what is DRAWN, not what was PLANNED. The solid bar
      // comes from the actuals, so an item that began earlier than anything on
      // the board was planned to used to land at a negative x — where the
      // outermost <svg> clips it, cutting off the head of the bar and most of
      // the green "started early" phantom. paintedSpan is the union of the two.
      const { start, end } = paintedSpan(item, now);

      if (start < minDate) minDate = start;
      if (end > maxDate) maxDate = end;
    }

    // Add padding
    const padStart = addDays(startOfDay(minDate), -3);
    const padEnd = addDays(startOfDay(maxDate), 7);
    const days = Math.max(diffDays(padStart, padEnd), 30);

    return { timelineStart: padStart, totalDays: days };
  }, [filteredItems]);

  const sortedItems = useMemo(() => visibleRows.map((r) => r.item), [visibleRows]);

  // Generate date headers
  const dateHeaders = useMemo(() => {
    const headers: Array<{ date: Date; label: string; isMonthStart: boolean; isWeekStart: boolean }> = [];
    for (let i = 0; i < totalDays; i++) {
      const d = addDays(timelineStart, i);
      headers.push({
        date: d,
        label: String(d.getDate()),
        isMonthStart: d.getDate() === 1,
        isWeekStart: d.getDay() === 1,
      });
    }
    return headers;
  }, [timelineStart, totalDays]);

  // Month labels
  const monthLabels = useMemo(() => {
    const labels: Array<{ month: string; startX: number; width: number }> = [];
    let currentMonth = "";
    let startIdx = 0;

    for (let i = 0; i < dateHeaders.length; i++) {
      const d = dateHeaders[i].date;
      const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
      if (monthKey !== currentMonth) {
        if (currentMonth !== "") {
          labels.push({
            month: new Date(
              dateHeaders[startIdx].date
            ).toLocaleString("default", { month: "short", year: "numeric" }),
            startX: startIdx * dayWidth,
            width: (i - startIdx) * dayWidth,
          });
        }
        currentMonth = monthKey;
        startIdx = i;
      }
    }
    // Push last month
    if (currentMonth !== "") {
      labels.push({
        month: new Date(
          dateHeaders[startIdx].date
        ).toLocaleString("default", { month: "short", year: "numeric" }),
        startX: startIdx * dayWidth,
        width: (dateHeaders.length - startIdx) * dayWidth,
      });
    }

    return labels;
  }, [dayWidth, dateHeaders]);

  // Bar geometry per item id — the SAME formulas the bar renderer below uses,
  // so the dependency-arrow layer can resolve each end's bar position. Keyed by
  // item id; only items with a visible row appear.
  const barPositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number; w: number; h: number }>();
    const nowDay = startOfDay(new Date());
    sortedItems.forEach((item, i) => {
      // Anchor arrows to the SOLID (primary) bar: the ACTUAL span when it exists
      // (what's drawn solid), else the planned span — never the faded planned trail
      // ("phantom"). Hover/detail are unaffected.
      //
      // Shared with the axis via lib/boards/timeline-span. This file used to
      // carry four separate span derivations, two planned-only and two
      // actual-preferred, and nothing made them agree — which is exactly how the
      // axis came to be built from dates the bars were not drawn at.
      const solid = solidSpan(item, nowDay);
      const start = startOfDay(solid.start);
      const end = startOfDay(solid.end);
      const startOffset = diffDays(timelineStart, start);
      const duration = Math.max(diffDays(start, end), 1);
      map.set(item.id, {
        x: startOffset * dayWidth,
        // Body-SVG coordinates: the date header lives in its own sticky SVG, so
        // rows start at y=0 here.
        y: i * ROW_HEIGHT + 8,
        w: Math.max(duration * dayWidth, dayWidth),
        h: ROW_HEIGHT - 16,
      });
    });
    return map;
  }, [dayWidth, sortedItems, timelineStart]);

  // ── Drag-to-reschedule ───────────────────────────────────────────────────
  // Drag a bar's body to shift both dates; drag its left/right edge to move just
  // the start/due. Day-snapped. Gated on ITEM_UPDATE (bars stay read-only
  // otherwise). Optimistic cache write, then PUT; on error we re-fetch to revert.
  const { can } = usePermissions();
  const canEdit = can(Permission.ITEM_UPDATE);
  const dragRef = useRef<{
    id: string;
    mode: DragMode;
    startClientX: number;
    origStart: Date;
    origEnd: Date;
    captured: boolean;
  } | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    id: string;
    mode: DragMode;
    deltaDays: number;
  } | null>(null);

  const beginDrag = useCallback(
    (item: WorkItem, mode: DragMode, e: React.PointerEvent) => {
      if (!canEdit) return;
      e.preventDefault();
      e.stopPropagation();
      const { start, end } = itemSpan(item);
      dragRef.current = {
        id: item.id,
        mode,
        startClientX: e.clientX,
        origStart: start,
        origEnd: end,
        captured: false,
      };
      setDragPreview({ id: item.id, mode, deltaDays: 0 });
      setHoveredItem(null);
    },
    [canEdit],
  );

  const onDragMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // Capture the pointer only once a real drag starts (>3px) — NEVER on a tap.
    // A tap that opens the detail sheet must not hold pointer capture, or the
    // sheet's controls (e.g. the status Select) won't get their clicks — the
    // Gantt-only "status dropdown won't open" bug.
    if (!d.captured && Math.abs(e.clientX - d.startClientX) > 3) {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      d.captured = true;
    }
    const deltaDays = Math.round((e.clientX - d.startClientX) / dayWidth);
    setDragPreview((p) =>
      p && p.deltaDays === deltaDays ? p : { id: d.id, mode: d.mode, deltaDays },
    );
  }, [dayWidth, ]);

  // The browser/OS can fire pointercancel mid-drag (touch scroll-takeover,
  // incoming call, palm rejection) — and then NO pointerup follows. Without
  // this the bar would stay stuck at its preview offset and tooltips would stay
  // suppressed (both guard on dragRef) until the next pointerdown. Cancel = drop
  // the gesture with no commit.
  const onDragCancel = useCallback(() => {
    dragRef.current = null;
    setDragPreview(null);
  }, []);

  // Persist a date snapshot (optimistic cache write + PUT). Shared by drag commit
  // and undo/redo so they behave identically.
  const commitDates = useCallback(
    (id: string, body: { startDate: string; dueDate: string }) => {
      qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
        prev?.map((it) => (it.id === id ? { ...it, ...body } : it)),
      );
      void (async () => {
        try {
          await jsonFetch(`${basePath}/work-items/${id}`, {
            method: "PUT",
            body: JSON.stringify(body),
          });
          toast.success("Schedule updated");
          qc.invalidateQueries({ queryKey: itemsKey });
        } catch (err) {
          notifyError(err, "Couldn't reschedule the item.");
          qc.invalidateQueries({ queryKey: itemsKey });
        }
      })();
    },
    [qc, itemsKey, basePath],
  );

  const onDragEnd = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      const deltaDays = Math.round((e.clientX - d.startClientX) / dayWidth);
      setDragPreview(null);
      if (deltaDays === 0) return; // a tap, not a drag — let onClick open detail
      justDraggedRef.current = true; // suppress the trailing click after a drag

      let newStart = d.origStart;
      let newEnd = d.origEnd;
      if (d.mode === "move") {
        newStart = addDays(d.origStart, deltaDays);
        newEnd = addDays(d.origEnd, deltaDays);
      } else if (d.mode === "start") {
        newStart = addDays(d.origStart, deltaDays);
        // Can't reach/cross the due date — clamp to a 1-day bar ending at it,
        // matching what the live preview shows (right edge pinned, min width).
        if (newStart >= newEnd) newStart = addDays(newEnd, -1);
      } else {
        newEnd = addDays(d.origEnd, deltaDays);
        if (newEnd < newStart) newEnd = newStart; // can't precede the start
      }

      const before = {
        startDate: d.origStart.toISOString(),
        dueDate: d.origEnd.toISOString(),
      };
      const after = {
        startDate: newStart.toISOString(),
        dueDate: newEnd.toISOString(),
      };
      setUndoStack((prev) => [...prev, { id: d.id, before, after }]);
      setRedoStack([]);
      commitDates(d.id, after);
    },
    [dayWidth, commitDates],
  );

  const undo = useCallback(() => {
    if (undoStack.length === 0) return;
    const op = undoStack[undoStack.length - 1];
    commitDates(op.id, op.before);
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((r) => [...r, op]);
  }, [undoStack, commitDates]);
  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const op = redoStack[redoStack.length - 1];
    commitDates(op.id, op.after);
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((u) => [...u, op]);
  }, [redoStack, commitDates]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
        return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Escape leaves fullscreen: the way out of a takeover layer has to work
  // without finding a button, because the layer is what hid the rest of the UI.
  // It stands down while the detail sheet is open so Escape closes the sheet
  // first — otherwise one keypress would dismiss both, and you'd land back on
  // the board wondering what happened to the ticket you were reading.
  useEffect(() => {
    if (!fullscreen || detailId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, detailId]);

  // ── Critical path ────────────────────────────────────────────────────────
  // "Critical" is not one thing, so the user picks what it means. Every mode is
  // the same longest-path DP over the dependency DAG (cycle-guarded); they
  // differ only in what a node is WORTH and which chain end is chosen.
  //
  //  dependencies  — the most-linked chain. Weight 1 per node, so the winner is
  //                  the chain with the most items in it. This is the one people
  //                  usually mean by "the critical path".
  //  duration      — the longest chain by summed bar length (the prior behaviour).
  //  latest-finish — the chain ending at the item that finishes last, i.e. the
  //                  one actually setting the plan's end date.
  //  at-risk       — the chain carrying the most trouble: overdue or blocked
  //                  items are weighted heavily, so it surfaces where a slip is
  //                  already happening rather than where one merely could.
  const criticalSet = useMemo(() => {
    if (!showCritical) return new Set<string>();
    // Local, not the `today` below: this memo is declared above it.
    const now = startOfDay(new Date());
    const ids = new Set(filteredItems.map((i) => i.id));
    const dur = new Map<string, number>();
    const endAt = new Map<string, number>();
    const weight = new Map<string, number>();
    for (const it of filteredItems) {
      const { start, end } = itemSpan(it);
      const d = Math.max(diffDays(start, end), 1);
      dur.set(it.id, d);
      endAt.set(it.id, end.getTime());
      const overdue = end < now && !it.completedAt;
      const blocked = (it.tags ?? []).some((t) => t.toLowerCase() === "blocked");
      weight.set(
        it.id,
        criticalMode === "dependencies"
          ? 1
          : criticalMode === "at-risk"
            ? (overdue ? 8 : 0) + (blocked ? 8 : 0) + 1
            : d,
      );
    }
    const preds = new Map<string, string[]>();
    for (const l of links) {
      if (ids.has(l.sourceItemId) && ids.has(l.targetItemId)) {
        const arr = preds.get(l.targetItemId) ?? [];
        arr.push(l.sourceItemId);
        preds.set(l.targetItemId, arr);
      }
    }
    const memo = new Map<string, number>();
    const best = new Map<string, string | null>();
    const visiting = new Set<string>();
    const dp = (id: string): number => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return weight.get(id) ?? 1; // cycle guard
      visiting.add(id);
      let bestVal = 0;
      let bestPred: string | null = null;
      for (const p of preds.get(id) ?? []) {
        const v = dp(p);
        if (v > bestVal) {
          bestVal = v;
          bestPred = p;
        }
      }
      visiting.delete(id);
      const total = (weight.get(id) ?? 1) + bestVal;
      memo.set(id, total);
      best.set(id, bestPred);
      return total;
    };
    let endId: string | null = null;
    let max = -1;
    for (const it of filteredItems) {
      const score = dp(it.id);
      // latest-finish ranks by when the chain ENDS, not by how heavy it is.
      const rank = criticalMode === "latest-finish" ? (endAt.get(it.id) ?? 0) : score;
      if (rank > max) {
        max = rank;
        endId = it.id;
      }
    }
    const set = new Set<string>();
    let cur: string | null = endId;
    while (cur) {
      set.add(cur);
      cur = best.get(cur) ?? null;
    }
    return set;
  }, [showCritical, criticalMode, filteredItems, links]);

  // Dependency focus: when the Dependencies lens is on and a bar is hovered,
  // resolve its DIRECT upstream (blockers) + downstream (dependents) so the
  // render can light that neighborhood and fade everything else (anti-spaghetti).
  const depFocus = useMemo(() => {
    if (!showDeps || !hoveredItem) return null;
    const up = new Set<string>();
    const down = new Set<string>();
    for (const l of links) {
      if (l.targetItemId === hoveredItem.id) up.add(l.sourceItemId);
      if (l.sourceItemId === hoveredItem.id) down.add(l.targetItemId);
    }
    return { id: hoveredItem.id, up, down, all: new Set<string>([hoveredItem.id, ...up, ...down]) };
  }, [showDeps, hoveredItem, links]);

  // ── Row selection ────────────────────────────────────────────────────────
  // What Shift acts on. It used to act on every visible item, so nudging two
  // tasks by a day silently re-dated the entire board — an edit nobody asked
  // for, hidden inside a button that looked like a small adjustment. The user
  // now names the items first, and Shift can only reach those.
  //
  // ONE model, two surfaces: the checkboxes in the work-items column and the
  // bars in the chart read and write this same Set. Two parallel states would
  // let a row look ticked while its bar looked idle, and the Shift buttons
  // could then act on a set the user was no longer looking at.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // The range anchor, file-explorer style: the last row clicked WITHOUT Shift.
  // A Shift-click measures from it and deliberately does not move it, which is
  // the rule every file list follows. Worth being honest about the blast radius
  // of that choice here: because the ranges below are additive, moving the
  // anchor on a Shift-click would produce the identical selection every time,
  // so this is the rule holding rather than a behaviour you can observe. It
  // stays explicit so the rule still reads correctly if ranges ever stop being
  // additive — which is exactly when it would start to matter.
  const anchorIdRef = useRef<string | null>(null);
  /** What a click means for the selection. `replace` = only this row (and
   *  re-anchor), `toggle` = flip this row alone, `range` = anchor→row. */
  type SelectIntent = "replace" | "toggle" | "range";
  const selectRow = useCallback(
    (id: string, intent: SelectIntent) => {
      // Resolve the range against the rows ACTUALLY ON SCREEN, in the order
      // they are drawn — a range the user traced down the column has to mean
      // the rows they traced, not whatever lies between them in the unfiltered
      // data. An anchor that has since been filtered or collapsed away simply
      // doesn't resolve, and the click degrades to a plain one.
      const anchor = anchorIdRef.current;
      const from =
        intent === "range" && anchor !== null
          ? sortedItems.findIndex((it) => it.id === anchor)
          : -1;
      const to = from === -1 ? -1 : sortedItems.findIndex((it) => it.id === id);
      const ranged = from !== -1 && to !== -1;

      setSelectedIds((prev) => {
        if (ranged) {
          // Union rather than replace. This selection arms the bulk Shift
          // buttons, so the dangerous direction is silently DROPPING rows that
          // were already ticked — a re-plan of items the user thought they had
          // set aside. Extending can only ever over-select, which is visible in
          // the count and undone by Clear.
          const next = new Set(prev);
          const [a, b] = from < to ? [from, to] : [to, from];
          for (let i = a; i <= b; i++) next.add(sortedItems[i].id);
          return next;
        }
        if (intent === "replace") return new Set([id]);
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      });

      // Only a resolved range keeps the old anchor; everything else (including
      // a Shift-click whose anchor has gone) re-anchors here, so the next
      // Shift-click always has a live row to measure from.
      if (!ranged) anchorIdRef.current = id;
    },
    [sortedItems],
  );

  // ── Bar clicks ───────────────────────────────────────────────────────────
  // A bar is the same work item as its row, so clicking one selects it with the
  // same modifiers the checkboxes answer to.
  //
  // That takes plain-click away from "open the detail sheet", which was its old
  // job, so the sheet moves to DOUBLE-click (right-click still opens it too, and
  // the ticket label in the work-items column is untouched). Two reasons for
  // that direction rather than putting selection behind a modifier: selecting is
  // the gesture you repeat — building a set to Shift means clicking bar after
  // bar, and a modifier on the common action is friction on every single one —
  // and a sheet that slides over the chart on every click is actively hostile
  // when what you are doing is comparing bars. Opening a ticket stays one
  // gesture away, and it kept all three of its other routes.
  const onBarClick = useCallback(
    (item: WorkItem, e: React.MouseEvent) => {
      // A real drag ends with a trailing click. Swallowing it here — the one
      // place every bar click funnels through — is what stops a reschedule from
      // also silently rewriting the selection. (Cleared on the next pointerdown
      // rather than here, so a drag that ends on a bar edge can't leave the flag
      // raised and eat the NEXT genuine click.)
      if (justDraggedRef.current) return;
      // Read-only viewers have no selection UI at all: no checkbox column, no
      // Shift buttons, no count. Selecting for them would trade the one thing a
      // bar click does — open the ticket — for a state they cannot see or use.
      if (!canEdit) {
        setDetailId(item.id);
        return;
      }
      selectRow(
        item.id,
        e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "replace",
      );
    },
    [canEdit, selectRow],
  );
  // The stored ids are intersected with the rows actually on screen rather than
  // trusted verbatim: filtering, collapsing a parent or switching to the
  // Dependencies lens can take a row away long after it was ticked, and moving
  // an item the user can no longer see is the same invisible bulk edit this
  // selection exists to prevent.
  const selectedItems = useMemo(
    () => sortedItems.filter((it) => selectedIds.has(it.id)),
    [sortedItems, selectedIds],
  );
  const allVisibleSelected =
    sortedItems.length > 0 && selectedItems.length === sortedItems.length;

  // ── Bulk schedule ops ────────────────────────────────────────────────────
  // Shift moves the SELECTED items by N days. The target list is a parameter
  // rather than something this reads off the visible rows, so "which items get
  // rewritten" is decided by the caller and visible at the call site — that
  // ambiguity is what let the old version move everything.
  // Optimistic cache write, then PUT each; refetch on any failure.
  const bulkReschedule = useCallback(
    async (
      targets: WorkItem[],
      compute: (span: { start: Date; end: Date }) => { start: Date; end: Date },
    ) => {
      if (!canEdit || busy || targets.length === 0) return;
      setBusy(true);
      const updates = targets.map((it) => {
        const next = compute(itemSpan(it));
        return {
          id: it.id,
          startDate: next.start.toISOString(),
          dueDate: next.end.toISOString(),
        };
      });
      qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
        prev?.map((it) => {
          const u = updates.find((x) => x.id === it.id);
          return u ? { ...it, startDate: u.startDate, dueDate: u.dueDate } : it;
        }),
      );
      const results = await Promise.allSettled(
        updates.map((u) =>
          jsonFetch(`${basePath}/work-items/${u.id}`, {
            method: "PUT",
            body: JSON.stringify({ startDate: u.startDate, dueDate: u.dueDate }),
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        notifyError(
          new Error("Some items couldn't be rescheduled"),
          `${failed} of ${updates.length} failed`,
        );
      } else {
        toast.success(`Rescheduled ${updates.length} item${updates.length === 1 ? "" : "s"}`);
      }
      qc.invalidateQueries({ queryKey: itemsKey });
      setBusy(false);
    },
    [canEdit, busy, qc, itemsKey, basePath],
  );

  const shiftDays = (days: number) =>
    void bulkReschedule(selectedItems, ({ start, end }) => ({
      start: addDays(start, days),
      end: addDays(end, days),
    }));

  const today = startOfDay(new Date());
  const todayOffset = diffDays(timelineStart, today);

  // Milestones that fall inside the visible window, placed on the same day grid
  // the bars use. Undated ones are skipped — there is nowhere honest to put them.
  const milestoneMarkers = useMemo(() => {
    const rows = (milestonesQ.data as ProjectMilestone[] | undefined) ?? [];
    return rows.flatMap((m) => {
      if (!m.dueDate) return [];
      const offset = diffDays(timelineStart, startOfDay(new Date(m.dueDate)));
      if (offset < 0 || offset >= totalDays) return [];
      return [{ ...m, x: offset * dayWidth + dayWidth / 2 }];
    });
  }, [dayWidth, milestonesQ.data, timelineStart, totalDays]);

  const svgWidth = totalDays * dayWidth;
  // The date header renders in its own sticky SVG; the body SVG holds only rows.
  const bodyHeight = sortedItems.length * ROW_HEIGHT + 20;

  if (loading) return <TimelineSkeleton />;

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-sm text-destructive mb-2">Failed to load board</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  // Only short-circuit when the board is TRULY empty. If items exist but the
  // active filters match none, fall through so the FilterBar still renders (the
  // user needs it to clear the filter) over an empty chart.
  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-muted-foreground">
          No work items to display on timeline. Items need start or due dates.
        </p>
      </div>
    );
  }

  return (
    // Fullscreen is a pure layout swap on this one container: the panes below
    // keep their slot in the tree, so entering and leaving neither remounts the
    // chart nor disturbs zoom, scroll position or the selection.
    <div
      data-testid="gantt-root"
      className={cn(
        "flex flex-col h-full",
        fullscreen && "fixed inset-0 z-50 bg-background",
      )}
    >
      {fullscreen && (
        <Button
          variant="outline"
          size="xs"
          onClick={() => setFullscreen(false)}
          aria-label="Exit fullscreen"
          title="Exit fullscreen (Esc)"
          // Floated over the chart's top-right rather than given a toolbar row:
          // a strip of chrome to hold one button is the chrome this view just
          // removed. Above the sticky headers (z-20) so it can't be scrolled under.
          className="absolute right-3 top-2 z-30 shadow-sm"
        >
          <Minimize2 className="size-3" /> Exit
        </Button>
      )}
      {!fullscreen && (
        <FilterBar
          filters={filters}
          onFilterChange={setFilters}
          members={members}
          intervals={intervals}
          teams={teams}
          presentLabelNames={presentLabelNames}
          boardColumns={projectStatuses}
          milestoneOptions={milestoneRows}
          presentPointValues={presentPointValues}
          showEstimate={showEstimate}
          orgId={orgId}
          customFields={projectCustomFields}
          presentTypeKeys={presentTypeKeys}
          presentCustomFieldKeys={presentCustomFieldKeys}
        />
      )}
      {!fullscreen && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Analysis lenses — overlay toggles that recolor/annotate the chart
                rather than change data. Grouped under one label so the toolbar
                reads as "ways to look at the schedule," not scattered buttons. */}
            <span className="text-xs font-medium text-muted-foreground">Lenses</span>
            <LensToggle
              active={showCritical}
              onClick={() => setShowCritical((v) => !v)}
              icon={<Route className="size-3.5" />}
              label="Critical path"
              title={
                CRITICAL_MODES.find((m) => m.key === criticalMode)?.hint ??
                "Highlight the driving chain of dependencies"
              }
              accent="var(--status-critical)"
            />
            {/* What "critical" MEANS is a judgement about the plan, not something
                this board can decide — so the definition is the user's, and the
                gear sits on the button it governs. */}
            <DropdownMenu>
              <DropdownMenuTrigger
                className="-ml-1 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Critical path settings"
                title="Choose what counts as the critical path"
              >
                <Settings2 className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuRadioGroup
                  value={criticalMode}
                  onValueChange={(v) => {
                    setCriticalMode(v as CriticalMode);
                    // Choosing a definition implies wanting to see it.
                    setShowCritical(true);
                  }}
                >
                  {/* The label lives INSIDE the radio group, not beside it.
                      base-ui's Menu.GroupLabel reads MenuGroupContext during
                      render and THROWS when there is no Menu.Group /
                      Menu.RadioGroup above it — and because the popup only
                      mounts on open, that throw landed in the app's error
                      boundary the moment the gear was clicked (in production,
                      as the minified Base UI error #31). Same trap already
                      documented in data-table.tsx and action-menu.tsx.
                      Nesting it here is also the more correct of the two
                      fixes: Menu.RadioGroup supplies that context AND adopts
                      the label's id as its aria-labelledby, so the choices
                      get an accessible name instead of a floating heading. */}
                  <DropdownMenuLabel>Highlight the chain with…</DropdownMenuLabel>
                  {CRITICAL_MODES.map((m) => (
                    <DropdownMenuRadioItem key={m.key} value={m.key}>
                      <span className="flex flex-col">
                        <span>{m.label}</span>
                        <span className="text-[11px] text-muted-foreground">{m.hint}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={criticalIsolate}
                  onCheckedChange={setCriticalIsolate}
                >
                  Dim everything off the path
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <LensToggle
              active={showBlocked}
              onClick={() => setShowBlocked((v) => !v)}
              icon={<Ban className="size-3.5" />}
              label="Blocked"
              title="Show impeded work in red, with arrows to whatever is blocking it"
              accent="var(--status-critical)"
            />
            <LensToggle
              active={hideDone}
              onClick={() => setHideDone((v) => !v)}
              icon={<EyeOff className="size-3.5" />}
              label="Hide done"
              title="Drop finished work from the chart so what is still in play has room"
              accent="var(--status-done)"
            />
            <LensToggle
              active={showPlanDrift}
              onClick={() => setShowPlanDrift((v) => !v)}
              icon={<GitCompareArrows className="size-3.5" />}
              label="Plan drift"
              title="Overlay the original planned dates (faded ghost) on the actual bars to see how the plan shifted"
              accent="var(--status-blocked)"
            />
            <LensToggle
              active={showEnablers}
              onClick={() => setShowEnablers((v) => !v)}
              icon={<Wrench className="size-3.5" />}
              label="Enablers"
              title="Emphasize enabler work (architecture, infra, compliance) vs. business value"
              accent="var(--type-enabler, #0891b2)"
            />
            <LensToggle
              active={showDeps}
              onClick={() => {
                setShowDeps((v) => !v);
                void qc.invalidateQueries({ queryKey: linksKey });
              }}
              icon={<Waypoints className="size-3.5" />}
              label="Dependencies"
              title="Show links between items; hover a bar to trace its upstream (amber) and downstream (blue) dependencies — everything else fades"
              accent="#0ea5e9"
            />
            <div className="mx-1 h-5 w-px bg-border" />
            {parentIds.size > 0 && (
              <button
                onClick={() =>
                  commitCollapsed(collapsedIds.size > 0 ? new Set() : new Set(parentIds))
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                title={
                  collapsedIds.size > 0
                    ? "Expand every parent item"
                    : "Collapse every parent item to a single row"
                }
              >
                {collapsedIds.size > 0 ? (
                  <>
                    <ChevronsUpDown className="size-3.5" /> Expand all
                  </>
                ) : (
                  <>
                    <ChevronsDownUp className="size-3.5" /> Collapse all
                  </>
                )}
              </button>
            )}
            {/* Zoom is a VIEW control, so it sits outside the canEdit guard — a
                read-only viewer needs to see the far end of a plan just as much. */}
            <div className="mx-1 h-5 w-px bg-border" />
            <span className="text-xs text-muted-foreground">Zoom</span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => zoomBy(1 / ZOOM_STEP)}
              disabled={zoom <= ZOOM_MIN + 0.001}
              title="Zoom out (⌘/Ctrl + scroll over the chart)"
              aria-label="Zoom out"
            >
              <ZoomOut className="size-3" />
            </Button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="min-w-11 rounded-md px-1 text-xs tabular-nums text-muted-foreground transition-colors hover:text-foreground"
              title="Reset zoom to 100%"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => zoomBy(ZOOM_STEP)}
              disabled={zoom >= ZOOM_MAX - 0.001}
              title="Zoom in (⌘/Ctrl + scroll over the chart)"
              aria-label="Zoom in"
            >
              <ZoomIn className="size-3" />
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => setFullscreen(true)}
              title="Fullscreen — just the work items and the calendar (Esc to exit)"
              aria-label="Enter fullscreen"
            >
              <Maximize2 className="size-3" />
            </Button>

            {canEdit && (
              <>
                <div className="mx-1 h-5 w-px bg-border" />
                <span className="text-xs text-muted-foreground">Shift</span>
                {[-7, -1, 1, 7].map((d) => (
                  <Button
                    key={d}
                    variant="outline"
                    size="xs"
                    // No selection → no shift. Falling back to "then move
                    // everything" is exactly the behaviour being fixed: it turns
                    // a mis-click into a board-wide re-plan.
                    disabled={busy || selectedItems.length === 0}
                    onClick={() => shiftDays(d)}
                    title={
                      selectedItems.length === 0
                        ? "Select the work items to shift first"
                        : `Shift ${selectedItems.length} selected item${selectedItems.length === 1 ? "" : "s"} ${d > 0 ? "+" : ""}${d} day${Math.abs(d) === 1 ? "" : "s"}`
                    }
                  >
                    {d < 0 ? <ChevronLeft className="size-3" /> : null}
                    {d > 0 ? "+" : ""}
                    {d}d
                    {d > 0 ? <ChevronRight className="size-3" /> : null}
                  </Button>
                ))}
                {/* The count carries the disabled buttons' reason. A `title` on a
                    disabled button never surfaces (pointer-events are off), so
                    without this the controls would just look broken. */}
                <span
                  data-testid="gantt-selection-count"
                  className="text-xs text-muted-foreground"
                >
                  {selectedItems.length === 0
                    ? "Select items to shift"
                    : `${selectedItems.length} selected`}
                </span>
                {selectedItems.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                    className="rounded-md px-1 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                    title="Clear the selection"
                  >
                    Clear
                  </button>
                )}
                <div className="mx-1 h-5 w-px bg-border" />
                <Button
                  variant="outline"
                  size="xs"
                  disabled={undoStack.length === 0}
                  onClick={undo}
                  title="Undo reschedule (⌘/Ctrl-Z)"
                >
                  <Undo2 className="size-3" /> Undo
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={redoStack.length === 0}
                  onClick={redo}
                  title="Redo reschedule (⌘/Ctrl-Y)"
                >
                  <Redo2 className="size-3" /> Redo
                </Button>
                {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canEdit && (
              <p className="hidden text-xs text-muted-foreground lg:block">
                Drag a bar to reschedule · drag edges to resize
              </p>
            )}
            <NewIssueButton
              orgId={orgId}
              projectId={projectId}
              projectKey={projectKey}
              boardId={boardId}
              onCreated={() => qc.invalidateQueries({ queryKey: itemsKey })}
            />
          </div>
        </div>
      )}
      {/* Contextual legend — only the keys for what's actually on screen, and
          only outside fullscreen: there the ask is the work items and the
          calendar, so every strip that isn't one of those two gets out of the way. */}
      {!fullscreen && (showPlanDrift || hasEnablers) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-[var(--surface)] px-4 py-1.5 text-[11px] text-muted-foreground">
          {showPlanDrift && (
            <>
              <span className="text-[var(--text-muted)]">Plan:</span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2 rounded-sm"
                  style={{ backgroundColor: BAND_COLORS.delivery.fill, opacity: PHANTOM_OPACITY }}
                />
                Planned
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2 rounded-sm"
                  style={{ backgroundColor: DRIFT_COLOR.green }}
                />
                Ahead
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2 rounded-sm"
                  style={{ backgroundColor: DRIFT_COLOR.red }}
                />
                Behind
              </span>
              <span className="text-[var(--text-muted)]">striped where it overlaps actual work</span>
            </>
          )}
          {hasEnablers && (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-5 rounded-sm bg-muted-foreground/30"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(45deg, rgba(255,255,255,0.6) 0 2px, transparent 2px 5px)",
                }}
              />
              Enabler work
            </span>
          )}
        </div>
      )}
      {/* ONE scroll container holds both the item labels and the chart, so
          vertical scroll is structurally locked: every label shares the same
          scroll flow as its bar. (The old design gave each pane its own scroller
          and mirrored scrollTop in JS — but the chart pane is taller and its
          viewport is shortened by the horizontal scrollbar, so it could scroll
          while the label pane had nothing to scroll: the tickets "didn't move.")
          The label column pins with `sticky left-0` during horizontal scroll;
          both headers pin with `sticky top-0`.

          `items-start` is REQUIRED for those `sticky top-0` headers to work
          (COSMOS-68). This is a flex row; with the default `align-items:
          stretch` each pane is stretched to the scroller's VIEWPORT height, which
          collapses the sticky containing block — the date/label headers then only
          pin for the first viewport-height of scroll and slide off after that
          (browser-verified). `items-start` sizes each pane to its own content, so
          the headers stay pinned the whole way down. */}
      <div
        data-testid="gantt-scroll"
        className="relative flex flex-1 items-start overflow-auto"
      >
        {/* Left column - item labels. Narrower on phones so the chart isn't
            crowded off-screen; the SVG rows align by height, not this width. */}
        <div
          data-testid="gantt-left"
          className="sticky left-0 z-20 shrink-0 border-r bg-background"
          // Row TEXT scales with zoom (clamped) so the two panes stay legible
          // together — zooming the bars right out used to leave full-size labels
          // beside hairline bars. Row HEIGHT is deliberately untouched: it is
          // what keeps these rows aligned with their bars in the SVG.
          style={{ width: nameColW, fontSize: `${labelScale(zoom)}rem` }}
        >
          <div
            className={cn(
              "sticky top-0 z-10 border-b bg-[var(--surface)] flex items-center text-xs font-medium text-muted-foreground",
              // Line the header checkbox up with the rows' (6px), but leave the
              // viewer's heading exactly where it was when there is none.
              canEdit ? "pl-1.5 pr-3" : "px-3",
            )}
            style={{ height: HEADER_HEIGHT }}
          >
            {canEdit && (
              // The same fixed gutter the rows use, so the select-all sits dead
              // on the column its rows' boxes form rather than near it.
              <span className={cn(SELECT_GUTTER, "justify-center")}>
                <Checkbox
                  checked={allVisibleSelected}
                  indeterminate={selectedItems.length > 0 && !allVisibleSelected}
                  onChange={() =>
                    setSelectedIds(
                      allVisibleSelected ? new Set() : new Set(sortedItems.map((it) => it.id)),
                    )
                  }
                  aria-label="Select all work items"
                  title="Select every row on screen"
                />
              </span>
            )}
            Work Items
          </div>
          {visibleRows.map(({ item, depth }) => {
            const colors = barColorsFor(item.workItemType?.key, isMilestoneItem(item));
            const isParent = parentIds.has(item.id);
            const isCollapsed = collapsedIds.has(item.id);
            const isSelected = selectedIds.has(item.id);
            return (
              <div
                key={item.id}
                className={cn(
                  "group/gantt-row flex w-full items-center border-b border-border/30 transition-colors",
                  isSelected ? "bg-[var(--primary)]/10" : "hover:bg-muted/30",
                )}
                style={{ height: ROW_HEIGHT, paddingLeft: 6 }}
              >
                {/* Ticking a row is what aims the Shift buttons at it. Only for
                    editors: with nothing to shift, a selection is just noise. */}
                {canEdit && (
                  <span className={cn(SELECT_GUTTER, "justify-center")}>
                    <Checkbox
                      checked={isSelected}
                      // All of the selection logic lives on the CLICK, not on
                      // change: `change` carries no modifier keys, so shift-range
                      // is unreachable from there. onChange is still required —
                      // React warns on a controlled checkbox without one — but it
                      // has deliberately nothing to do.
                      onChange={() => {}}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectRow(
                          item.id,
                          // A checkbox is a toggle affordance, so a plain click
                          // keeps toggling (and re-anchors) rather than replacing
                          // the selection the way a bar click does — same split a
                          // file explorer makes between a file's tick box and the
                          // file itself.
                          e.shiftKey ? "range" : "toggle",
                        );
                      }}
                      aria-label={`Select ${projectKey}-${item.ticketNumber}`}
                      title={`Select ${projectKey}-${item.ticketNumber} to shift it — Shift-click to select a range`}
                      className={cn(
                        // Unobtrusive until it's relevant: the column is a list
                        // of tickets first. The boxes fade up on row hover or
                        // keyboard focus, and once ANY row is selected they all
                        // stay up — mid-selection you need to see the whole
                        // pattern of what's on and off, not just the row your
                        // cursor happens to be over.
                        "transition-opacity",
                        selectedItems.length === 0 &&
                          "opacity-0 group-hover/gantt-row:opacity-100 focus-visible:opacity-100",
                        // Coarse pointers have no hover, so a hover-only reveal
                        // makes the boxes unreachable on a tablet.
                        "[@media(pointer:coarse)]:opacity-100",
                      )}
                    />
                  </span>
                )}
                {/* The hierarchy indent sits AFTER the checkbox rather than in
                    the row's padding, so the checkboxes hold one column instead
                    of stair-stepping away with depth. */}
                {depth > 0 && <span className="shrink-0" style={{ width: depth * 14 }} />}
                {isParent ? (
                  <button
                    type="button"
                    onClick={() => toggleCollapse(item.id)}
                    aria-label={isCollapsed ? "Expand children" : "Collapse children"}
                    aria-expanded={!isCollapsed}
                    className="mr-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <ChevronRight
                      className={cn("size-3.5 transition-transform", !isCollapsed && "rotate-90")}
                    />
                  </button>
                ) : (
                  <span className="w-[22px] shrink-0" />
                )}
                <button
                  type="button"
                  onClick={() => setDetailId(item.id)}
                  title={`${projectKey}-${item.ticketNumber}: ${item.title}`}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 pr-3 text-left"
                >
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: colors.fill }}
                  />
                  <div className="min-w-0 flex-1">
                    {/* em, not text-xs: a rem-based Tailwind size would OVERRIDE
                        the zoom-scaled fontSize on the column and the label
                        would never move. 0.75em reproduces text-xs at 100%. */}
                    <p className="truncate" style={{ fontSize: "0.75em" }}>
                      <span className="text-muted-foreground mr-1">
                        {projectKey}-{item.ticketNumber}
                      </span>
                      {item.title}
                    </p>
                  </div>
                </button>
              </div>
            );
          })}
          {/* Drag handle — resize the Work Items column (persisted). */}
          <div
            onPointerDown={onNameResizeDown}
            onPointerMove={onNameResizeMove}
            onPointerUp={onNameResizeUp}
            onPointerCancel={onNameResizeUp}
            className="absolute right-0 top-0 bottom-0 z-30 w-1.5 translate-x-1/2 cursor-col-resize hover:bg-[var(--primary)]/40"
            style={{ touchAction: "none" }}
            title="Drag to resize the Work Items column"
          />
        </div>

        {/* Right column - the chart. Sized to its full content; the shared outer
            container does the scrolling for both panes. */}
        <div
          data-testid="gantt-chart"
          className="shrink-0"
          style={{ width: svgWidth }}
          // Ctrl/Cmd + wheel zooms, matching how maps and design tools behave.
          // A BARE wheel is deliberately left alone: the rows scroll vertically
          // and the chart scrolls horizontally, and stealing that would make a
          // long plan unnavigable. preventDefault stops the browser's own
          // page-zoom from firing on the same gesture.
          onWheel={(e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
          }}
        >
            {/* Sticky date header (FR e4d1732e / COSMOS-68): pinned to the outer
                scroller while scrolling down (needs `items-start` on the scroller
                — see the scroll container above), but scrolls horizontally with
                the chart because it sits inside the svgWidth chart column —
                `sticky top-0` only pins the vertical axis. */}
            <div
              data-testid="gantt-date-header"
              className="sticky top-0 z-10 border-b border-border bg-[var(--surface)]"
              style={{ height: HEADER_HEIGHT }}
            >
              <svg width={svgWidth} height={HEADER_HEIGHT} className="block">
                {monthLabels.map((m, i) => (
                  <g key={i}>
                    <rect
                      x={m.startX}
                      y={0}
                      width={m.width}
                      height={24}
                      className="fill-muted/50"
                    />
                    <text
                      x={m.startX + m.width / 2}
                      y={16}
                      textAnchor="middle"
                      className="fill-muted-foreground text-[10px]"
                      style={{ fontSize: 10 }}
                    >
                      {m.month}
                    </text>
                  </g>
                ))}
                {dateHeaders.map((h, i) => {
                  const x = i * dayWidth;
                  const isWeekend = h.date.getDay() === 0 || h.date.getDay() === 6;
                  return (
                    <g key={i}>
                      {isWeekend && (
                        <rect
                          x={x}
                          y={24}
                          width={dayWidth}
                          height={HEADER_HEIGHT - 24}
                          className="fill-muted/20"
                        />
                      )}
                      <text
                        x={x + dayWidth / 2}
                        y={40}
                        textAnchor="middle"
                        className="fill-muted-foreground text-[9px]"
                        style={{ fontSize: 9 }}
                      >
                        {h.label}
                      </text>
                    </g>
                  );
                })}
                {/* Today dot — the dashed line itself lives in the body SVG. */}
                {todayOffset >= 0 && todayOffset < totalDays && (
                  <circle
                    cx={todayOffset * dayWidth + dayWidth / 2}
                    cy={HEADER_HEIGHT - 5}
                    r={4}
                    fill="var(--status-critical)"
                  />
                )}
              </svg>
            </div>

            <svg
              width={svgWidth}
              height={bodyHeight}
              className="block"
              // Every new gesture in the chart starts from a clean slate. The
              // "that click was really the tail of a drag" flag used to be
              // cleared by whoever consumed it, which meant a drag finishing on
              // a bar's resize edge (those have no click handler) left it raised
              // and ate the next genuine click on some other bar. Capture phase
              // so it lands before any bar's own pointerdown.
              onPointerDownCapture={() => {
                justDraggedRef.current = false;
              }}
            >
            <defs>
              {/* Arrowhead for dependency links. */}
              <marker
                id="timeline-dep-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
              </marker>
              <marker
                id="timeline-dep-arrow-crit"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--status-critical)" />
              </marker>
              {/* Directional dependency arrows for the hover-focus view. */}
              <marker id="timeline-dep-arrow-up" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
              </marker>
              <marker id="timeline-dep-arrow-down" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#0ea5e9" />
              </marker>
              {/* Diagonal hatch overlay marking ENABLER work (architecture,
                  infra, compliance) — a texture that reads regardless of the
                  bar's type color. */}
              <pattern
                id="timeline-enabler-hatch"
                width="6"
                height="6"
                patternTransform="rotate(45)"
                patternUnits="userSpaceOnUse"
              >
                <rect width="6" height="6" fill="transparent" />
                {/* Reads as ~1 wide, not 2 — the tile clips its content, so a
                    stroke centred on x=0 loses its left half. Same trap as the
                    red drift hatch below, and left alone for the same measured
                    reason: the clipped edge is hard, and that is what makes the
                    texture crisp. */}
                <line x1="0" y1="0" x2="0" y2="6" stroke="white" strokeWidth="2" opacity="0.55" />
              </pattern>
              {/* Drift stripes — a MATCHED PAIR, identical but for the hue,
                  because green and red are the two ends of one axis and any
                  difference in texture would read as a difference in kind.

                  Used only where a mark lies ON the bar (an early start over the
                  bar's head, a late finish over its tail). A solid fill there
                  would paint out real work and read as though the bar stopped
                  short; the stripes let the actual span show through the gaps.

                  Both draw at x=0 and so paint about HALF their nominal width —
                  pattern content is clipped to its tile. That is deliberate and
                  measured: rewriting red as a centred 1.25 to make the number
                  honest came out WORSE (dE 44.1 -> 33.3, ink 42.5% -> 55.6%),
                  because a clipped edge is hard where a centred stroke has two
                  antialiased ones. Adjust these by measuring, not by arithmetic.

                  Green needed a darker casing stripe while bars were green
                  themselves (mint on #22c55e measured dE ~11). Bars are blue and
                  purple now, so the hue does that work and the casing is gone. */}
              <pattern
                id="timeline-drift-green"
                width="7"
                height="7"
                patternTransform="rotate(45)"
                patternUnits="userSpaceOnUse"
              >
                <rect width="7" height="7" fill="transparent" />
                <line x1="0" y1="0" x2="0" y2="7" stroke="#6ee7b7" strokeWidth="2.5" />
              </pattern>
              <pattern
                id="timeline-drift-red"
                width="7"
                height="7"
                patternTransform="rotate(45)"
                patternUnits="userSpaceOnUse"
              >
                <rect width="7" height="7" fill="transparent" />
                <line x1="0" y1="0" x2="0" y2="7" stroke="var(--status-critical)" strokeWidth="2.5" />
              </pattern>
            </defs>

            {/* Weekend shading + week gridlines */}
            {dateHeaders.map((h, i) => {
              const x = i * dayWidth;
              const isWeekend = h.date.getDay() === 0 || h.date.getDay() === 6;
              if (!isWeekend && !h.isWeekStart) return null;
              return (
                <g key={i}>
                  {isWeekend && (
                    <rect
                      x={x}
                      y={0}
                      width={dayWidth}
                      height={bodyHeight}
                      className="fill-muted/20"
                    />
                  )}
                  {h.isWeekStart && (
                    <line
                      x1={x}
                      y1={0}
                      x2={x}
                      y2={bodyHeight}
                      className="stroke-border/50"
                      strokeWidth={0.5}
                    />
                  )}
                </g>
              );
            })}

            {/* Row separators */}
            {sortedItems.map((_, i) => (
              <line
                key={i}
                x1={0}
                y1={(i + 1) * ROW_HEIGHT}
                x2={svgWidth}
                y2={(i + 1) * ROW_HEIGHT}
                className="stroke-border/30"
                strokeWidth={0.5}
              />
            ))}

            {/* Dependency links (prod-parity): a curved connector from the
                source bar's right edge to the target bar's left edge, with an
                arrowhead at the target. Rendered UNDER the bars. Endpoints whose
                bar isn't currently on a visible row are skipped. */}
            {(showDeps || showCritical || showBlocked) &&
              links.map((link) => {
                const from = barPositions.get(link.sourceItemId);
                const to = barPositions.get(link.targetItemId);
                if (!from || !to) return null;
                const x1 = from.x + from.w;
                const y1 = from.y + from.h / 2;
                const x2 = to.x;
                const y2 = to.y + to.h / 2;
                const midX = (x1 + x2) / 2;
                const crit =
                  showCritical &&
                  criticalSet.has(link.sourceItemId) &&
                  criticalSet.has(link.targetItemId);
                const downstream = !!depFocus && link.sourceItemId === depFocus.id;
                const upstream = !!depFocus && link.targetItemId === depFocus.id;
                // The Blocked lens draws its edges persistently, not just on
                // hover — the point is to SEE what is holding work up without
                // having to go looking for it.
                const isBlockEdge = showBlocked && isBlockingLink(link.type);
                // deps off: only the critical chain (and blocking edges, when
                // that lens is on) shows.
                if (!crit && !showDeps && !isBlockEdge) return null;
                let stroke = "#94a3b8";
                let sw = 1.25;
                let opacity = 0.34;
                let marker = "url(#timeline-dep-arrow)";
                if (isBlockEdge) {
                  // Red, and heavier than a plain dependency: an impediment is
                  // not the same class of fact as an ordering constraint.
                  stroke = "var(--status-critical)";
                  sw = 2.5;
                  opacity = 1;
                  marker = "url(#timeline-dep-arrow-crit)";
                } else if (crit) {
                  stroke = "var(--status-critical)";
                  sw = 2.5;
                  opacity = 1;
                  marker = "url(#timeline-dep-arrow-crit)";
                } else if (depFocus) {
                  if (downstream || upstream) {
                    stroke = downstream ? "#0ea5e9" : "#f59e0b";
                    sw = 2.5;
                    opacity = 1;
                    marker = downstream ? "url(#timeline-dep-arrow-down)" : "url(#timeline-dep-arrow-up)";
                  } else {
                    opacity = 0.06;
                    sw = 1;
                  }
                }
                return (
                  <path
                    key={link.id}
                    d={`M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`}
                    stroke={stroke}
                    strokeWidth={sw}
                    opacity={opacity}
                    fill="none"
                    markerEnd={marker}
                  >
                    <title>
                      {projectKey}-{link.sourceTicketNumber} {link.type}{" "}
                      {projectKey}-{link.targetTicketNumber}
                    </title>
                  </path>
                );
              })}

            {/* Work item bars */}
            {sortedItems.map((item, i) => {
              const start = item.startDate
                ? startOfDay(new Date(item.startDate))
                : startOfDay(new Date(item.createdAt));
              const end = item.dueDate
                ? startOfDay(new Date(item.dueDate))
                : addDays(start, 7);

              const startOffset = diffDays(timelineStart, start);
              const duration = Math.max(diffDays(start, end), 1);

              const baseX = startOffset * dayWidth;
              const y = i * ROW_HEIGHT + 8;
              const baseW = Math.max(duration * dayWidth, dayWidth);
              const h = ROW_HEIGHT - 16;

              // Apply the live drag preview to this bar's geometry (day-snapped),
              // clamped so a resize can't invert the bar.
              let x = baseX;
              let w = baseW;
              const preview = dragPreview?.id === item.id ? dragPreview : null;
              if (preview) {
                const px = preview.deltaDays * dayWidth;
                if (preview.mode === "move") {
                  x = baseX + px;
                } else if (preview.mode === "start") {
                  x = Math.min(baseX + px, baseX + baseW - dayWidth);
                  w = baseX + baseW - x;
                } else {
                  w = Math.max(baseW + px, dayWidth);
                }
              }

              const isMilestone = isMilestoneItem(item);
              const colors = barColorsFor(item.workItemType?.key, isMilestone);
              const prog = progressOf(item, doneKeys);
              const isSelected = selectedIds.has(item.id);
              const isCrit = showCritical && criticalSet.has(item.id);
              const isEnabler = item.workCategory === "ENABLER";
              // Blocked lens: impeded work turns red and everything else recedes,
              // so a board of any size answers "what is stuck" at a glance.
              // Dimmed rather than hidden — a blocker is usually NOT itself
              // blocked, and hiding it would remove the thing the arrow points at.
              const isBlocked = showBlocked && blockedIds.has(item.id);
              const dimForBlockedLens = showBlocked && !isBlocked ? 0.35 : 1;
              // Business items dim slightly while the Enabler lens is on so the
              // hatched enablers pop; enablers keep full opacity.
              const dimForEnablerLens = showEnablers && !isEnabler ? 0.4 : 1;
              // Dependency hover-focus: fade bars outside the hovered item neighborhood.
              const depDim = depFocus && !depFocus.all.has(item.id) ? 0.22 : 1;
              // Isolate the chosen path: everything off it recedes so the path
              // reads at a glance. Dimmed, not hidden — a path needs the rest of
              // the plan visible to be critical relative to anything.
              const critDim = showCritical && criticalIsolate && !isCrit ? 0.15 : 1;
              // ONE dim, not four multiplied together. Four active lenses used to
              // reach 0.85 x 0.4 x 0.35 x 0.22 x 0.15 — about 0.4% opacity, a bar
              // present in the DOM and invisible on screen. Taking the STRONGEST
              // single factor keeps every dimmed element at a predictable level,
              // so planned-vs-actual and the outline marks stay legible however
              // many lenses are on.
              const lensDim = Math.min(dimForEnablerLens, dimForBlockedLens, depDim, critDim);

              // PRIMARY (solid) = the ACTUAL span at real dates. The plan shows up
              // as drift PHANTOMS around it — amber/green for the start, red for an
              // end slip — rather than as one ghost of the whole planned span tinted
              // by health, which could say "late" but never "late by this much, and
              // here". With no actuals yet the planned span IS the solid bar
              // (future/planning items) and no phantom is drawn.
              const plannedStartD = item.startDate ? startOfDay(new Date(item.startDate)) : null;
              const actualStartD = item.actualStart ? startOfDay(new Date(item.actualStart)) : null;
              const actualEndD = item.completedAt ? startOfDay(new Date(item.completedAt)) : today;
              let actualBar: { x: number; w: number } | null = null;
              if (actualStartD) {
                const ax = diffDays(timelineStart, actualStartD) * dayWidth;
                const aw = Math.max(diffDays(actualStartD, actualEndD) * dayWidth, 3);
                actualBar = { x: ax, w: aw };
              }
              // Nothing has been actioned: no actual start, and the work has not
              // been moved into a started column. Such a bar is a PLAN, not progress,
              // and is drawn as a phantom so the two are not confused at a glance.
              const notStarted = !actualStartD && !item.completedAt;
              const primaryX = actualBar ? actualBar.x : x;
              const primaryW = actualBar ? actualBar.w : w;
              // Where the PLAN disagreed with the actuals. Each end is judged on
              // its own: GREEN where the actuals beat the plan, RED where they ran
              // behind it, STRIPED where the mark lies over the bar and a shadow
              // where it lands on bare canvas. See lib/boards/plan-drift.ts.
              // Returned in paint order — phantoms first, then stripes, red last.
              const driftPhantoms = planDriftPhantoms({
                plannedStart: plannedStartD,
                plannedEnd: item.dueDate ? startOfDay(new Date(item.dueDate)) : null,
                actualStart: actualStartD,
                // A REAL end only: a completion, or today for something known to
                // be RUNNING. Never the bare `today` fallback for work that has
                // not started, or every un-started overdue item sprouts a red
                // tail it has not earned. An item completed with no recorded
                // start DOES belong here — its slip is real, and gating this on
                // actualStart is what used to hide it.
                actualEnd: actualStartD || item.completedAt ? actualEndD : null,
              }).map((ph) => ({
                color: ph.color,
                style: ph.style,
                edge: ph.edge,
                x: diffDays(timelineStart, ph.from) * dayWidth,
                w: Math.max(diffDays(ph.from, ph.to) * dayWidth, 2),
              }));

              const enter = (e: React.MouseEvent) => {
                if (dragRef.current) return;
                setHoveredItem(item);
                setTooltipPos({ x: e.clientX, y: e.clientY });
              };

              if (isMilestone) {
                const cx = x + dayWidth / 2;
                const cy = y + h / 2;
                const size = 8;
                const diamond = (dcx: number, s: number) =>
                  `${dcx},${cy - s} ${dcx + s},${cy} ${dcx},${cy + s} ${dcx - s},${cy}`;
                // A milestone is a DATE, not a span, so it cannot carry the
                // striped/shadow marks a bar does. It drifts the only way a point
                // can: it moves. So draw where it was planned as a shadow, where
                // it actually landed as the solid diamond, and join the two with a
                // line coloured by direction. Two diamonds and a rule — it reads
                // instantly and adds no clutter when nothing moved.
                const mActual = item.completedAt
                  ? startOfDay(new Date(item.completedAt))
                  : actualStartD;
                const actualCx =
                  mActual === null ? null : diffDays(timelineStart, mActual) * dayWidth + dayWidth / 2;
                const solidCx = actualCx ?? cx;
                // Nothing has happened to it yet: the plan IS the milestone, so it
                // is a shadow, exactly like an un-started bar.
                const notReached = actualCx === null;
                const driftDir: DriftColor | null =
                  mActual && plannedStartD && mActual.getTime() !== plannedStartD.getTime()
                    ? mActual.getTime() < plannedStartD.getTime()
                      ? "green"
                      : "red"
                    : null;
                const showMoved = showPlanDrift && driftDir !== null && actualCx !== null;
                return (
                  <g
                    key={item.id}
                    onMouseEnter={enter}
                    onMouseLeave={() => setHoveredItem(null)}
                    onPointerDown={(e) => beginDrag(item, "move", e)}
                    onPointerMove={onDragMove}
                    onPointerUp={onDragEnd}
                    onPointerCancel={onDragCancel}
                    onClick={(e) => onBarClick(item, e)}
                    onDoubleClick={() => setDetailId(item.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setHoveredItem(null);
                      setDetailId(item.id);
                    }}
                    data-testid={`gantt-bar-${item.id}`}
                    data-selected={isSelected || undefined}
                    style={{ touchAction: canEdit ? "none" : undefined }}
                    className={canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}
                  >
                    {/* Where it was PLANNED, and the move. Drawn first so the
                        solid diamond lands on top of the connector. */}
                    {showMoved && (
                      <>
                        <polygon
                          points={diamond(cx, size)}
                          fill={colors.fill}
                          stroke="none"
                          opacity={PHANTOM_OPACITY * lensDim}
                          onClick={(e) => onBarClick(item, e)}
                          className="cursor-pointer"
                          data-testid={`gantt-milestone-planned-${item.id}`}
                        />
                        <line
                          x1={cx}
                          y1={cy}
                          x2={solidCx}
                          y2={cy}
                          stroke={DRIFT_COLOR[driftDir!]}
                          strokeWidth={2}
                          opacity={lensDim}
                          style={{ pointerEvents: "none" }}
                          data-testid={`gantt-milestone-drift-${driftDir}-${item.id}`}
                        />
                        {/* An invisible, much thicker copy carrying the pointer.
                            The visible connector is 2px, which is a miserable
                            hover target; widening the MARK to fix that would
                            shout far louder than a milestone that moved three
                            days deserves. So the hit area is widened instead and
                            the drawing left alone. */}
                        <line
                          x1={cx}
                          y1={cy}
                          x2={solidCx}
                          y2={cy}
                          stroke="transparent"
                          strokeWidth={h}
                          onClick={(e) => onBarClick(item, e)}
                          onDoubleClick={() => setDetailId(item.id)}
                          className="cursor-pointer"
                          data-testid={`gantt-milestone-drift-hit-${item.id}`}
                        />
                      </>
                    )}
                    <polygon
                      points={diamond(solidCx, size)}
                      fill={colors.fill}
                      stroke={
                        isBlocked
                          ? "var(--status-critical)"
                          : isCrit
                            ? "var(--status-critical)"
                            : isEnabler && showEnablers
                              ? "var(--type-enabler, #0891b2)"
                              : colors.stroke
                      }
                      // Lateness is carried by the drift connector now, so the
                      // outline is left to mean what it means on every other
                      // shape: blocked, critical chain, enabler. One signal, one
                      // channel.
                      strokeWidth={isBlocked || isCrit ? 2.5 : 1.5}
                      opacity={(notReached ? PHANTOM_OPACITY : 1) * lensDim}
                    />
                    {/* Selection is drawn as a ring OUTSIDE the shape rather
                        than by restyling it. The fill and stroke already carry
                        data — type, health, critical chain — and overloading
                        them would make "I clicked this" and "this is late" fight
                        over the same pixels. */}
                    {isSelected && (
                      <polygon
                        points={diamond(solidCx, size + 3.5)}
                        fill="none"
                        stroke="var(--primary)"
                        strokeWidth={2}
                        style={{ pointerEvents: "none" }}
                      />
                    )}
                  </g>
                );
              }

              // Nothing is known about WHEN this is. Draw the one real date it
              // has — when it was created — as a hollow dot with no width, and
              // say so in words. A point cannot be misread as a span, and the
              // label removes any doubt. Deliberately NOT a diamond: that shape
              // now means milestone.
              if (isUndatedItem(item)) {
                const cy = y + h / 2;
                return (
                  <g
                    key={item.id}
                    onMouseEnter={enter}
                    onMouseMove={(e) => {
                      if (dragRef.current) return;
                      setTooltipPos({ x: e.clientX, y: e.clientY });
                    }}
                    onMouseLeave={() => setHoveredItem(null)}
                    onClick={(e) => onBarClick(item, e)}
                    onDoubleClick={() => setDetailId(item.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setHoveredItem(null);
                      setDetailId(item.id);
                    }}
                    data-testid={`gantt-bar-${item.id}`}
                    data-undated="true"
                    data-selected={isSelected || undefined}
                    className="cursor-pointer"
                  >
                    <circle
                      cx={x + 5}
                      cy={cy}
                      r={4.5}
                      fill="none"
                      stroke={colors.stroke}
                      strokeWidth={1.5}
                      opacity={PHANTOM_OPACITY * lensDim}
                    />
                    <text
                      x={x + 15}
                      y={cy + 3.5}
                      className="fill-muted-foreground"
                      style={{ fontSize: 10, fontStyle: "italic" }}
                      opacity={lensDim}
                    >
                      No dates
                    </text>
                  </g>
                );
              }

              const EDGE = 7;
              return (
                <g
                  key={item.id}
                  onMouseEnter={enter}
                  onMouseMove={(e) => {
                    if (dragRef.current) return;
                    setTooltipPos({ x: e.clientX, y: e.clientY });
                  }}
                  onMouseLeave={() => setHoveredItem(null)}
                >
                  {/* Planned bar. No actuals → it IS the item: draggable, and drawn
                      as a PHANTOM because nothing has happened to it yet, and a
                      solid bar for un-started work is indistinguishable from work
                      in flight. Same PHANTOM_OPACITY as the drift marks, so "this
                      is the plan" looks the same everywhere on the chart. Actuals
                      exist → the drift marks below carry the plan instead.

                      No dashed outline: a border here would compete with the
                      outlines that mean blocked / critical / enabler, which are
                      the only things allowed to change a bar's edge. */}
                  {!actualBar ? (
                    <rect
                      x={x}
                      y={y}
                      width={w}
                      height={h}
                      rx={4}
                      fill={colors.fill}
                      stroke={
                        isBlocked
                          ? "var(--status-critical)"
                          : isCrit
                          ? "var(--status-critical)"
                          : isEnabler && showEnablers
                            ? "var(--type-enabler, #0891b2)"
                            : colors.stroke
                      }
                      strokeWidth={isBlocked || isCrit ? 2.5 : isEnabler ? 1.5 : 1}
                      strokeDasharray={isEnabler ? "5 3" : undefined}
                      opacity={(preview ? 1 : notStarted ? PHANTOM_OPACITY : 1) * lensDim}
                      onPointerDown={(e) => beginDrag(item, "move", e)}
                      onPointerMove={onDragMove}
                      onPointerUp={onDragEnd}
                      onPointerCancel={onDragCancel}
                      onClick={(e) => onBarClick(item, e)}
                      onDoubleClick={() => setDetailId(item.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setHoveredItem(null);
                        setDetailId(item.id);
                      }}
                      data-testid={`gantt-bar-${item.id}`}
                      data-selected={isSelected || undefined}
                      style={{ touchAction: canEdit ? "none" : undefined }}
                      className={canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}
                    />
                  ) : null}
                  {/* PHANTOM marks, BEHIND the bar. These land on bare canvas —
                      a late start to the left of the bar, an early finish to its
                      right — so nothing covers them and the bar keeps its edge.
                      Shadows, at the one phantom opacity, with no outline. */}
                  {showPlanDrift &&
                    driftPhantoms
                      .filter((ph) => ph.style === "phantom")
                      .map((ph) => (
                        <rect
                          key={`${item.id}-drift-${ph.color}-${ph.edge}`}
                          data-testid={`gantt-drift-${ph.color}-${ph.edge}-${item.id}`}
                          x={ph.x}
                          y={y}
                          width={ph.w}
                          height={h}
                          rx={4}
                          fill={DRIFT_COLOR[ph.color]}
                          stroke="none"
                          opacity={PHANTOM_OPACITY * lensDim}
                          // HOVERABLE, unlike the striped marks. A shadow is the
                          // only part of a row that sits on bare canvas, so it is
                          // the only part the pointer can reach without passing
                          // through the bar — and it is exactly the part a user
                          // points at to ask "how far off was this?". It cannot
                          // steal the bar's clicks because it never overlaps it.
                          onClick={(e) => onBarClick(item, e)}
                          onDoubleClick={() => setDetailId(item.id)}
                          className="cursor-pointer"
                        />
                      ))}
                  {/* Actual bar — the SOLID primary (real dates). Click opens the
                      detail panel; started/done items reschedule there, not by drag. */}
                  {actualBar && (
                    <rect
                      x={primaryX}
                      y={y}
                      width={primaryW}
                      height={h}
                      rx={4}
                      fill={colors.fill}
                      // isBlocked belongs here, FIRST, exactly as on the planned
                      // bar. It used to be missing: the Blocked lens outlined only
                      // items with no actual start, so work that had actually begun
                      // — which is most of what gets blocked — showed nothing but
                      // the surrounding dimming. The lens was weakest precisely
                      // where it was needed.
                      stroke={
                        isBlocked
                          ? "var(--status-critical)"
                          : isCrit
                            ? "var(--status-critical)"
                            : isEnabler && showEnablers
                              ? "var(--type-enabler, #0891b2)"
                              : colors.stroke
                      }
                      strokeWidth={isBlocked || isCrit ? 2.5 : isEnabler ? 1.5 : 1}
                      strokeDasharray={isEnabler ? "5 3" : undefined}
                      // Fully solid. Actual dates are SOLID and planned dates are
                      // shadows; anything less than 1 here blurs that line.
                      opacity={1 * lensDim}
                      onClick={(e) => onBarClick(item, e)}
                      onDoubleClick={() => setDetailId(item.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setHoveredItem(null);
                        setDetailId(item.id);
                      }}
                      data-testid={`gantt-bar-${item.id}`}
                      data-selected={isSelected || undefined}
                      className="cursor-pointer"
                    />
                  )}
                  {/* Progress fill on the primary — % complete. Non-interactive. */}
                  {prog > 0 && (
                    <rect
                      x={primaryX}
                      y={y}
                      width={Math.max(primaryW * prog, 2)}
                      height={h}
                      rx={4}
                      fill={colors.stroke}
                      opacity={preview ? 0.65 : 0.5}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                  {/* Enabler texture on the primary. */}
                  {isEnabler && (
                    <rect
                      x={primaryX}
                      y={y}
                      width={primaryW}
                      height={h}
                      rx={4}
                      fill="url(#timeline-enabler-hatch)"
                      opacity={showEnablers ? 1 : 0.6}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                  {/* STRIPED marks LAST. These sit ON the bar by construction —
                      green over its head (began early), red over its tail (ran
                      late) — so painted behind it they would be invisible at any
                      opacity. Red comes last within the group, so a slip wins
                      wherever two marks meet. */}
                  {showPlanDrift &&
                    driftPhantoms
                      .filter((ph) => ph.style === "striped")
                      .map((ph) => (
                        <rect
                          key={`${item.id}-drift-${ph.color}-${ph.edge}`}
                          data-testid={`gantt-drift-${ph.color}-${ph.edge}-${item.id}`}
                          x={ph.x}
                          y={y}
                          width={ph.w}
                          height={h}
                          rx={4}
                          // HATCH, not a fill: this mark lies ON the actual bar, so
                          // a solid fill would paint over real work and read as if
                          // the bar stopped there. The stripes keep the solid span
                          // visible between them — both legible at once, which is
                          // the whole point of the overlap.
                          fill={`url(#timeline-drift-${ph.color})`}
                          // No outline. A border here would compete with the marks
                          // that DO mean something on an edge — blocked, critical,
                          // enabler — and the stripes already carry the shape.
                          stroke="none"
                          // Near-opaque so the stripes read at full strength; the
                          // transparency that lets the bar through comes from the
                          // pattern's gaps, not from fading the whole rect.
                          opacity={STRIPE_OPACITY * lensDim}
                          style={{ pointerEvents: "none" }}
                        />
                      ))}
                  {canEdit && !actualBar && (
                    <>
                      {/* Left edge → move start date */}
                      <rect
                        x={x}
                        y={y}
                        width={EDGE}
                        height={h}
                        rx={4}
                        fill="transparent"
                        onPointerDown={(e) => beginDrag(item, "start", e)}
                        onPointerMove={onDragMove}
                        onPointerUp={onDragEnd}
                        onPointerCancel={onDragCancel}
                        style={{ cursor: "ew-resize", touchAction: "none" }}
                      />
                      {/* Right edge → move due date */}
                      <rect
                        x={x + w - EDGE}
                        y={y}
                        width={EDGE}
                        height={h}
                        rx={4}
                        fill="transparent"
                        onPointerDown={(e) => beginDrag(item, "end", e)}
                        onPointerMove={onDragMove}
                        onPointerUp={onDragEnd}
                        onPointerCancel={onDragCancel}
                        style={{ cursor: "ew-resize", touchAction: "none" }}
                      />
                    </>
                  )}
                  {/* Selection ring — drawn OUTSIDE the bar rather than by
                      restyling it. Fill and stroke already carry data (type,
                      health, critical chain, enabler hatch); reusing them for
                      selection would make "I clicked this" and "this is late"
                      compete for the same pixels. Kept at full opacity through
                      every lens dim, because what you have selected is the one
                      thing that must not fade while you aim the Shift buttons. */}
                  {isSelected && (
                    <rect
                      x={primaryX - 2}
                      y={y - 2}
                      width={primaryW + 4}
                      height={h + 4}
                      rx={6}
                      fill="none"
                      stroke="var(--primary)"
                      strokeWidth={2}
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                  {primaryW > 60 && (
                    <text
                      x={primaryX + 6}
                      y={y + h / 2 + 3.5}
                      className={cn("text-[10px]", colors.text)}
                      style={{ fontSize: 10, fill: "white", pointerEvents: "none" }}
                    >
                      {item.title.length > Math.floor(primaryW / 6)
                        ? item.title.slice(0, Math.floor(primaryW / 6)) + "..."
                        : item.title}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Milestone markers — the SAME rows the Milestones board shows.
                Drawn under the today marker so "now" stays the most prominent
                line. Clicking one opens it on the milestones surface rather
                than in a Gantt-only popup, so there is one place to edit it. */}
            {milestoneMarkers.map((m) => (
              <g key={m.id} data-testid="gantt-milestone">
                <line
                  x1={m.x}
                  y1={0}
                  x2={m.x}
                  y2={bodyHeight}
                  stroke="var(--primary)"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                  opacity={0.5}
                />
                <a href={`${projectBase}/milestones?open=${m.id}`}>
                  <title>{`${m.title}${m.status ? ` · ${m.status}` : ""}`}</title>
                  <rect
                    x={m.x - 5}
                    y={bodyHeight - 12}
                    width={10}
                    height={10}
                    transform={`rotate(45 ${m.x} ${bodyHeight - 7})`}
                    fill="var(--primary)"
                    className="cursor-pointer"
                  />
                </a>
              </g>
            ))}

            {/* Today marker — the dot sits in the sticky header SVG above. */}
            {todayOffset >= 0 && todayOffset < totalDays && (
              <line
                x1={todayOffset * dayWidth + dayWidth / 2}
                y1={0}
                x2={todayOffset * dayWidth + dayWidth / 2}
                y2={bodyHeight}
                stroke="var(--status-critical)"
                strokeWidth={2}
                strokeDasharray="4 2"
              />
            )}
            </svg>
          </div>

          {/* Hover tooltip */}
          {hoveredItem && (
            <div
              data-testid="gantt-hover-card"
              className="fixed z-50 rounded-lg bg-popover border shadow-lg p-3 pointer-events-none max-w-xs"
              style={{
                left: tooltipPos.x + 12,
                top: tooltipPos.y + 12,
              }}
            >
              <p className="text-sm font-medium mb-1">
                {projectKey}-{hoveredItem.ticketNumber}: {hoveredItem.title}
              </p>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p>
                  Type: {hoveredItem.workItemType?.name ?? "Unknown"}
                  {hoveredItem.workCategory === "ENABLER" && (
                    <span className="ml-1 rounded-sm bg-[var(--type-enabler)]/15 px-1 text-[var(--type-enabler)]">
                      Enabler
                    </span>
                  )}
                </p>
                <p>Priority: {hoveredItem.priority}</p>
                {hoveredItem.assigneeId && (
                  <p>Assignee: {memberMap.get(hoveredItem.assigneeId) ?? "Unknown"}</p>
                )}
                {hoveredItem.startDate && (
                  <p>Start: {new Date(hoveredItem.startDate).toLocaleDateString()}</p>
                )}
                {hoveredItem.dueDate && (
                  <p>Due: {new Date(hoveredItem.dueDate).toLocaleDateString()}</p>
                )}
                {/* Slippage — Actual End (or today) vs Projected End. */}
                {hoveredItem.dueDate &&
                  (() => {
                    const slip = slipDays({
                      projectedEnd: startOfDay(new Date(hoveredItem.dueDate)),
                      actualEnd: hoveredItem.completedAt
                        ? startOfDay(new Date(hoveredItem.completedAt))
                        : null,
                      now: today,
                    });
                    if (slip === null) return null;
                    if (slip === 0) return <p>On schedule</p>;
                    return (
                      <p className={slip > 0 ? "text-[var(--status-critical)]" : "text-[var(--status-done)]"}>
                        {slip > 0 ? `Slipped ${slip}d late` : `${-slip}d ahead of plan`}
                      </p>
                    );
                  })()}
                {/* Start delta — Actual Start later than Planned Start (slow start). */}
                {hoveredItem.startDate &&
                  hoveredItem.actualStart &&
                  (() => {
                    const sd = Math.round(
                      (startOfDay(new Date(hoveredItem.actualStart)).getTime() -
                        startOfDay(new Date(hoveredItem.startDate)).getTime()) /
                        86_400_000,
                    );
                    if (sd <= 0) return null;
                    const fSlip = hoveredItem.dueDate
                      ? slipDays({
                          projectedEnd: startOfDay(new Date(hoveredItem.dueDate)),
                          actualEnd: hoveredItem.completedAt
                            ? startOfDay(new Date(hoveredItem.completedAt))
                            : null,
                          now: today,
                        })
                      : null;
                    const recovered =
                      hoveredItem.completedAt != null && fSlip != null && fSlip <= 0;
                    return (
                      <p className="text-[#f59e0b]">
                        Started {sd}d late{recovered ? " — recovered ✓" : ""}
                      </p>
                    );
                  })()}
                {hoveredItem.actualStart && (
                  <p>Actual start: {new Date(hoveredItem.actualStart).toLocaleDateString()}</p>
                )}
                {hoveredItem.completedAt && (
                  <p>Actual end: {new Date(hoveredItem.completedAt).toLocaleDateString()}</p>
                )}
                {hoveredItem.storyPoints != null && (
                  <p>Points: {hoveredItem.storyPoints}</p>
                )}
              </div>
            </div>
          )}
      </div>

      {/* Shared work-item detail — same sheet the Kanban/Table views use, so a
          ticket opened from the Timeline shows + edits identical data (FR). */}
      <CardDetailSheet
        statusColumns={projectStatuses}
        item={detailItem}
        open={detailItem !== null}
        onOpenChange={(o) => !o && setDetailId(null)}
        orgId={orgId}
        projectId={projectId}
        members={members}
        intervals={intervals}
        columns={columns}
        projectItems={items}
        onUpdate={(updated) =>
          qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
            prev?.map((it) => (it.id === updated.id ? updated : it)),
          )
        }
        onDelete={(id) => {
          qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
            prev?.filter((it) => it.id !== id),
          );
          setDetailId(null);
        }}
        onItemCreated={() => qc.invalidateQueries({ queryKey: itemsKey })}
        onChildrenReordered={() => qc.invalidateQueries({ queryKey: itemsKey })}
        onOpenItem={(id) => setDetailId(id)}
      />
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex overflow-hidden">
        <div className="shrink-0 border-r w-[260px] space-y-2 p-3">
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
        <div className="flex-1 p-3">
          <Skeleton className="h-full w-full" />
        </div>
      </div>
    </div>
  );
}
