"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import {
  projectStatusColumns,
  type StatusColumn,
} from "@/lib/boards/project-statuses";

interface BoardWithColumns {
  id: string;
  columns?: StatusColumn[] | null;
}

/**
 * The statuses a project's work can be in — the options for the Status filter.
 *
 * Board views used to pass their OWN `board.columns`, and board creation seeds
 * none, so Timeline/Gantt, Roadmap and Calendar had no columns and the Status
 * control silently never rendered. A work item's `columnKey` is a project-level
 * value, so the options are unioned across the project's boards instead.
 *
 * Uses the boards LIST endpoint, which already team-narrows what it returns —
 * so this cannot surface statuses from a board the viewer may not see. The query
 * is org-scoped and shared, so boards that already load this list pay nothing
 * extra.
 */
export function useProjectStatuses(orgId: string, projectId: string) {
  const key = useOrgQueryKey("boards", projectId);
  const { data } = useQuery({
    queryKey: key,
    queryFn: () =>
      jsonFetch<BoardWithColumns[]>(
        `/api/v1/orgs/${orgId}/projects/${projectId}/boards`
      ),
  });

  return useMemo(() => projectStatusColumns(data ?? []), [data]);
}
