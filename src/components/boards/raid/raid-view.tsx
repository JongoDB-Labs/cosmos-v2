"use client";

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  ShieldAlert,
  Check,
  Tag as TagIcon,
  type LucideIcon,
} from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ActionMenu,
  type ActionMenuGroup,
} from "@/components/ui/action-menu";
import { cn } from "@/lib/utils";
import type { WorkItem, OrgMember } from "@/types/models";

interface RaidViewProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

/**
 * RAID = Risks, Assumptions, Issues, Dependencies. The data model has no
 * dedicated RAID field, so categorization rides on a work-item TAG: an item
 * tagged `risk` / `assumption` / `issue` / `dependency` (case-insensitive)
 * lands in the matching column; anything else falls into "Unclassified".
 *
 * Re-categorizing just rewrites tags: drop any existing RAID tag, add the
 * chosen one, preserve every other (non-RAID) tag. The 4 RAID tags are
 * mutually exclusive here — an item belongs to exactly one column.
 */

type RaidKey = "risk" | "assumption" | "issue" | "dependency";

interface RaidCategory {
  key: RaidKey;
  /** The lowercase tag written to the work item. */
  tag: RaidKey;
  label: string; // singular, used in the selector menu
  columnLabel: string; // plural, used as the column header
  /** Theme/CSS color used for the column accent + count chip. */
  color: string;
}

const RAID_CATEGORIES: RaidCategory[] = [
  {
    key: "risk",
    tag: "risk",
    label: "Risk",
    columnLabel: "Risks",
    color: "#ef4444", // red
  },
  {
    key: "assumption",
    tag: "assumption",
    label: "Assumption",
    columnLabel: "Assumptions",
    color: "#f59e0b", // amber
  },
  {
    key: "issue",
    tag: "issue",
    label: "Issue",
    columnLabel: "Issues",
    color: "#f97316", // orange
  },
  {
    key: "dependency",
    tag: "dependency",
    label: "Dependency",
    columnLabel: "Dependencies",
    color: "#3b82f6", // blue
  },
];

const RAID_TAGS = new Set<string>(RAID_CATEGORIES.map((c) => c.tag));

const UNCLASSIFIED_COLOR = "var(--text-muted)";

const priorityDot: Record<WorkItem["priority"], string> = {
  CRITICAL: "bg-red-500",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-yellow-500",
  LOW: "bg-green-500",
};

const priorityLabel: Record<WorkItem["priority"], string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

/** Prettify a columnKey like `in_progress` → `In Progress`. */
function prettifyStatus(key: string): string {
  if (!key) return "—";
  return key
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * The RAID category an item currently belongs to, by the FIRST of its tags
 * (case-insensitive) that matches a RAID tag. `null` ⇒ Unclassified.
 */
function categorize(item: WorkItem): RaidKey | null {
  for (const t of item.tags) {
    const lower = t.toLowerCase();
    if (RAID_TAGS.has(lower)) return lower as RaidKey;
  }
  return null;
}

/**
 * Rewrite an item's tags for a target RAID category (or `null` to clear):
 * strip every RAID tag, then add the chosen one. Preserves the order and
 * values of all non-RAID tags. Comparison is case-insensitive so a stray
 * `Risk` is removed too.
 */
function retag(existing: string[], next: RaidKey | null): string[] {
  const kept = existing.filter((t) => !RAID_TAGS.has(t.toLowerCase()));
  return next ? [...kept, next] : kept;
}

export function RaidView({
  orgId,
  projectId,
  projectKey,
}: RaidViewProps) {
  // `boardId` is part of the board-view contract (every view receives it) but
  // RAID groups by tag, not by board columns, so it isn't read here.
  const [hideDone, setHideDone] = useState(false);

  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const itemsKey = useOrgQueryKey("work-items", projectId);
  const membersKey = useOrgQueryKey("members");

  const [itemsQ, membersQ] = useQueries({
    queries: [
      {
        queryKey: itemsKey,
        queryFn: () => jsonFetch<WorkItem[]>(`${basePath}/work-items`),
      },
      {
        queryKey: membersKey,
        queryFn: () =>
          jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`),
      },
    ],
  });

  const items: WorkItem[] = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);

  const loading = itemsQ.isLoading || membersQ.isLoading;
  const fatalError = itemsQ.error;
  const error = fatalError
    ? fatalError instanceof Error
      ? fatalError.message
      : "Unknown error"
    : null;

  const memberById = useMemo(() => {
    const map = new Map<string, OrgMember>();
    for (const m of membersQ.data ?? []) map.set(m.userId, m);
    return map;
  }, [membersQ.data]);

  // Re-tag mutation. Invalidates the work-items query so a card hops columns.
  // Keyed by itemId so the in-flight category sticks to one card.
  const retagMutation = useOrgMutation<
    unknown,
    Error,
    { itemId: string; tags: string[] }
  >({
    mutationFn: ({ itemId, tags }) =>
      jsonFetch(`${basePath}/work-items/${itemId}`, {
        method: "PUT",
        body: JSON.stringify({ tags }),
      }),
    invalidate: [["work-items", projectId]],
  });

  // Bucket every (filtered) item into its RAID column. `null` key ⇒ Unclassified.
  const grouped = useMemo(() => {
    const map = new Map<RaidKey | "__none__", WorkItem[]>();
    for (const cat of RAID_CATEGORIES) map.set(cat.key, []);
    map.set("__none__", []);
    for (const item of items) {
      if (hideDone && item.columnKey === "done") continue;
      const cat = categorize(item);
      map.get(cat ?? "__none__")!.push(item);
    }
    return map;
  }, [items, hideDone]);

  const totalShown = useMemo(
    () =>
      Array.from(grouped.values()).reduce((sum, list) => sum + list.length, 0),
    [grouped],
  );

  if (loading) return <RaidViewSkeleton />;

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-sm text-[var(--status-blocked,#ef4444)] mb-2">
            Failed to load RAID log
          </p>
          <p className="text-xs text-[var(--text-muted)]">{error}</p>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={ShieldAlert}
          title="No items to triage"
          description="Risks, assumptions, issues, and dependencies you tag will show up here. Tag a work item risk, assumption, issue, or dependency to populate the RAID log."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)]">
        <span className="text-sm font-semibold text-[var(--text)]">
          RAID log
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          {totalShown} item{totalShown === 1 ? "" : "s"}
        </span>

        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={hideDone}
            onChange={(e) => setHideDone(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
          />
          Hide done
        </label>
      </div>

      {/* Columns */}
      <div className="flex gap-3 overflow-x-auto scrollbar-x flex-1 p-4">
        {RAID_CATEGORIES.map((cat) => (
          <RaidColumn
            key={cat.key}
            categoryKey={cat.key}
            label={cat.columnLabel}
            color={cat.color}
            items={grouped.get(cat.key) ?? []}
            projectKey={projectKey}
            memberById={memberById}
            onRecategorize={(item, next) =>
              retagMutation.mutate({
                itemId: item.id,
                tags: retag(item.tags, next),
              })
            }
            isPending={retagMutation.isPending}
          />
        ))}
        <RaidColumn
          categoryKey={null}
          label="Unclassified"
          color={UNCLASSIFIED_COLOR}
          items={grouped.get("__none__") ?? []}
          projectKey={projectKey}
          memberById={memberById}
          onRecategorize={(item, next) =>
            retagMutation.mutate({
              itemId: item.id,
              tags: retag(item.tags, next),
            })
          }
          isPending={retagMutation.isPending}
        />
      </div>
    </div>
  );
}

interface RaidColumnProps {
  /** Current category of this column; `null` for Unclassified. */
  categoryKey: RaidKey | null;
  label: string;
  color: string;
  items: WorkItem[];
  projectKey: string;
  memberById: Map<string, OrgMember>;
  onRecategorize: (item: WorkItem, next: RaidKey | null) => void;
  isPending: boolean;
}

function RaidColumn({
  categoryKey,
  label,
  color,
  items,
  projectKey,
  memberById,
  onRecategorize,
  isPending,
}: RaidColumnProps) {
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
      {/* Color accent bar */}
      <div
        className="h-1 rounded-t-[var(--radius)]"
        style={{ backgroundColor: color }}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
            style={{ backgroundColor: color }}
            aria-hidden
          />
          <h3 className="text-sm font-medium text-[var(--text)]">{label}</h3>
        </div>
        <span
          className="inline-flex items-center justify-center rounded-full px-1.5 text-[11px] font-medium min-w-[20px] h-5"
          style={{
            backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)`,
            color,
          }}
        >
          {items.length}
        </span>
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2 min-h-[60px]">
        {items.map((item) => (
          <RaidCard
            key={item.id}
            item={item}
            currentCategory={categoryKey}
            projectKey={projectKey}
            assignee={
              item.assigneeId ? memberById.get(item.assigneeId) ?? null : null
            }
            onRecategorize={onRecategorize}
            isPending={isPending}
          />
        ))}

        {items.length === 0 && (
          <div className="py-8 text-center text-xs text-[var(--text-muted)]">
            No items
          </div>
        )}
      </div>
    </div>
  );
}

interface RaidCardProps {
  item: WorkItem;
  currentCategory: RaidKey | null;
  projectKey: string;
  assignee: OrgMember | null;
  onRecategorize: (item: WorkItem, next: RaidKey | null) => void;
  isPending: boolean;
}

function RaidCard({
  item,
  currentCategory,
  projectKey,
  assignee,
  onRecategorize,
  isPending,
}: RaidCardProps) {
  const ticketLabel = projectKey
    ? `${projectKey}-${item.ticketNumber}`
    : `#${item.ticketNumber}`;

  // Selector: the 4 RAID categories (current one check-marked + disabled),
  // then a "Clear" action when the item currently sits in a RAID column.
  const menuGroups: ActionMenuGroup[] = [
    {
      label: "Categorize",
      items: RAID_CATEGORIES.map((cat) => ({
        label: cat.label,
        icon: cat.key === currentCategory ? Check : (TagIcon as LucideIcon),
        disabled: cat.key === currentCategory || isPending,
        onClick: () => onRecategorize(item, cat.key),
      })),
    },
    {
      items:
        currentCategory !== null
          ? [
              {
                label: "Clear",
                disabled: isPending,
                onClick: () => onRecategorize(item, null),
              },
            ]
          : [],
    },
  ];

  return (
    <ActionMenu groups={menuGroups}>
      <div className="group/action relative rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors hover:border-[var(--primary)]/50">
        <div className="flex items-start gap-2 mb-2">
          <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">
            {ticketLabel}
          </span>
          <h4 className="text-sm font-medium leading-snug line-clamp-2 flex-1 text-[var(--text)]">
            {item.title}
          </h4>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Priority chip */}
            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-[color-mix(in_oklab,var(--text-muted)_12%,transparent)] text-[var(--text-muted)]">
              <span
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  priorityDot[item.priority],
                )}
                aria-hidden
              />
              {priorityLabel[item.priority]}
            </span>

            {/* Status */}
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-[color-mix(in_oklab,var(--text-muted)_12%,transparent)] text-[var(--text-muted)]">
              {prettifyStatus(item.columnKey)}
            </span>
          </div>

          {/* Assignee */}
          {assignee ? (
            <Avatar size="sm">
              {assignee.user?.avatarUrl && (
                <AvatarImage src={assignee.user.avatarUrl} />
              )}
              <AvatarFallback>
                {(assignee.user?.displayName ?? "?").charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          ) : (
            <span className="text-[10px] text-[var(--text-muted)]">
              Unassigned
            </span>
          )}
        </div>
      </div>
    </ActionMenu>
  );
}

function RaidViewSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)]">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-5 w-16" />
      </div>
      <div className="flex gap-3 overflow-x-auto flex-1 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="w-72 shrink-0 space-y-3">
            <Skeleton className="h-8 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
            {i < 3 && <Skeleton className="h-20 w-full rounded-lg" />}
          </div>
        ))}
      </div>
    </div>
  );
}
