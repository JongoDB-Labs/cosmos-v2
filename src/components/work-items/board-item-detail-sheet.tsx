"use client";

import { useQueries, useQueryClient } from "@tanstack/react-query";
import { CardDetailSheet } from "@/components/work-items/card-detail-sheet";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import {
  projectStatusColumns,
  type StatusColumn,
} from "@/lib/boards/project-statuses";
import type {
  Board,
  BoardColumn,
  Interval,
  OrgMember,
  WorkItem,
} from "@/types/models";

interface BoardItemDetailSheetProps {
  /** The clicked item. `null` closes the sheet. */
  itemId: string | null;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  projectId: string;
  /**
   * The host board, for its own columns. Only a fallback for the Status list —
   * the options come from the project's boards (see `projectStatuses` below),
   * because most board types are created owning no columns at all.
   */
  boardId?: string;
}

/**
 * A fully-editable work item for boards that only render items, not context.
 *
 * The Kanban, Backlog, Roadmap and Timeline boards already load columns,
 * members and intervals to draw themselves, so they hand those straight to
 * CardDetailSheet. The Table, Calendar and RAID boards don't — they render from
 * work items alone, which is why clicking an item on them used to do nothing.
 * Rather than teaching each of those three to load three more things purely to
 * open a ticket, this owns that fetch once.
 *
 * It deliberately reuses the host's query keys, so on a board that already
 * loaded members (all of them do) this costs one request for the item itself,
 * and a save writes back into the very cache entry the host renders from — the
 * board updates behind the sheet with no callback plumbing.
 */
export function BoardItemDetailSheet({
  itemId,
  onOpenChange,
  orgId,
  projectId,
  boardId,
}: BoardItemDetailSheetProps) {
  const qc = useQueryClient();
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  const staleTime = 30_000;

  const itemKey = useOrgQueryKey("work-item", itemId);
  const itemsKey = useOrgQueryKey("work-items", projectId);
  const boardKey = useOrgQueryKey("board", boardId);
  const membersKey = useOrgQueryKey("members");
  const intervalsKey = useOrgQueryKey("intervals", projectId);
  // The SAME key `useProjectStatuses` uses, so a host that already loads the
  // boards list (Table, Calendar and RAID all do, for their filter bar) shares
  // the cache entry and this costs no extra request. Not the hook itself: it has
  // no `enabled`, and this wrapper must fetch NOTHING until a ticket is clicked.
  const boardsKey = useOrgQueryKey("boards", projectId);

  const [itemQ, boardQ, membersQ, intervalsQ, boardsQ] = useQueries({
    queries: [
      {
        queryKey: itemKey,
        queryFn: () =>
          jsonFetch<WorkItem>(`${basePath}/work-items/${itemId}`),
        enabled: !!itemId,
      },
      {
        queryKey: boardKey,
        queryFn: () => jsonFetch<Board>(`${basePath}/boards/${boardId}`),
        enabled: !!itemId && !!boardId,
        staleTime,
      },
      {
        queryKey: membersKey,
        queryFn: () => jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`),
        enabled: !!itemId,
        staleTime,
      },
      {
        queryKey: intervalsKey,
        queryFn: () => jsonFetch<Interval[]>(`${basePath}/intervals`),
        enabled: !!itemId,
        staleTime,
      },
      {
        queryKey: boardsKey,
        queryFn: () =>
          jsonFetch<{ columns?: StatusColumn[] | null }[]>(`${basePath}/boards`),
        enabled: !!itemId,
        staleTime,
      },
    ],
  });

  const item = (itemQ.data as WorkItem | undefined) ?? null;
  const columns: BoardColumn[] = [
    ...(((boardQ.data as Board | undefined)?.columns ?? []) as BoardColumn[]),
  ].sort((a, b) => a.sortOrder - b.sortOrder);

  // WHERE THE STATUS OPTIONS COME FROM.
  //
  // `columnKey` is a PROJECT-level value, but this wrapper had only the HOST
  // board's columns — and board creation seeds none: `POST /boards` fills them
  // from `BOARD_TYPE_REGISTRY[type].defaultColumns`, which only SPRINT_PLANNING
  // and SPRINT_REVIEW declare. So every board type that reaches this sheet —
  // DASHBOARD, TABLE, CALENDAR, RAID — owns ZERO columns, and the Status control
  // rendered an empty menu over the raw key ("review" instead of "Review").
  // Reported against Sprint Health's overdue drill-down; it was never one board's
  // bug.
  //
  // Unioning the project's boards is the same source the Status FILTER (#670)
  // and the Backlog/Roadmap/Timeline sheets already use, so a ticket offers the
  // same statuses wherever it is opened — and it stays per-project, picking up a
  // team's renamed columns rather than any hard-coded list.
  //
  // The boards LIST endpoint is already team-narrowed, so this cannot surface a
  // status from a board the viewer may not see.
  const projectStatuses = projectStatusColumns(boardsQ.data ?? []);

  // Held closed until the FULL item lands. The sheet seeds its form once per
  // item id, so opening it against a partial row and swapping the complete one
  // in afterwards would leave the user editing stale values.
  return (
    <CardDetailSheet
      item={item}
      open={!!itemId && !!item}
      onOpenChange={onOpenChange}
      orgId={orgId}
      projectId={projectId}
      members={(membersQ.data as OrgMember[] | undefined) ?? []}
      intervals={(intervalsQ.data as Interval[] | undefined) ?? []}
      columns={columns}
      // `undefined`, not `[]`, while the boards list is in flight: the sheet
      // reads `statusColumns ?? columns`, so an empty array would suppress the
      // host board's own columns rather than fall back to them.
      statusColumns={projectStatuses.length > 0 ? projectStatuses : undefined}
      // The sheet does no cache work of its own — it reports the saved row and
      // leaves persistence to the host. Writing the row straight into the list
      // the board renders from keeps the card behind the sheet in step without
      // refetching the whole project on every inline field save.
      onUpdate={(updated) => {
        qc.setQueryData(itemKey, updated);
        qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
          prev?.map((i) => (i.id === updated.id ? { ...i, ...updated } : i)),
        );
      }}
      onDelete={(id) => {
        qc.setQueryData<WorkItem[]>(itemsKey, (prev) =>
          prev?.filter((i) => i.id !== id),
        );
        onOpenChange(false);
      }}
    />
  );
}
