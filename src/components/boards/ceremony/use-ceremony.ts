"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useRealtimeEvents } from "@/hooks/use-realtime-events";
import type { SprintReview } from "@/lib/intervals/sprint-review";

export interface CeremonyItem {
  id: string;
  ticketNumber: number;
  title: string;
  columnKey: string;
  storyPoints: number | null;
  statusLabel?: string;
}

export interface CeremonyNote {
  id: string;
  columnKey: string;
  text: string;
  authorId: string | null;
  isMine: boolean;
  createdAt: string;
}

export interface CeremonyAction {
  id: string;
  text: string;
  ownerId: string | null;
  dueDate: string | null;
  workItemId: string | null;
}

export interface CeremonyColumn {
  key: string;
  name: string;
  color: string;
  category: string;
  sortOrder: number;
}

export interface CeremonyPayload {
  sprint: {
    id: string;
    number: number;
    name: string;
    goal: string;
    startDate: string;
    endDate: string;
    status: "PLANNED" | "ACTIVE" | "COMPLETED";
  };
  increment: {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
  } | null;
  board: {
    id: string;
    name: string;
    type: string;
    config: { classification?: string; showNoteAuthors?: boolean } | null;
  };
  columns: CeremonyColumn[];
  metrics: SprintReview;
  shipped: CeremonyItem[];
  /**
   * `unrecorded` means the sprint closed before we began recording which items
   * moved. It is NOT an empty list — the UI must say so rather than imply a
   * clean sprint.
   */
  carried: { kind: "live" | "recorded" | "unrecorded"; items: CeremonyItem[] };
  nextSprint: { name: string; startDate: string; endDate: string };
  ceremony: {
    id: string;
    kind: "PLANNING" | "REVIEW";
    status: "DRAFT" | "RUNNING" | "CLOSED";
    closedAt: string | null;
    notes: CeremonyNote[];
    actionItems: CeremonyAction[];
  } | null;
}

/**
 * The whole ceremony in one query, refetched when any client changes it.
 *
 * The realtime event carries only a ceremony reference, so this refetch is what
 * actually moves the data — see the API's publishCeremonyChanged.
 */
export function useCeremony(args: {
  orgId: string;
  projectId: string;
  intervalId: string | null;
  boardId: string;
}) {
  const { orgId, projectId, intervalId, boardId } = args;
  const qc = useQueryClient();
  const key = useOrgQueryKey("ceremony", boardId, intervalId ?? "none");

  const query = useQuery({
    queryKey: key,
    enabled: Boolean(intervalId),
    queryFn: () =>
      jsonFetch<CeremonyPayload>(
        `/api/v1/orgs/${orgId}/projects/${projectId}/intervals/${intervalId}/ceremony?boardId=${boardId}`
      ),
  });

  useRealtimeEvents(orgId, {
    "ceremony.changed": () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });

  return query;
}
