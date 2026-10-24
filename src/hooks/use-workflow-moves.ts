"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";

type MoveMap = Record<string, string[]> | null;

/**
 * Where the signed-in person could move a project's items, for dimming the
 * columns a dragged card can't go to. `allowedFrom(typeId, status)` is null
 * when anything goes (the open workflow, or not loaded yet). Never decides a
 * move: the server does.
 */
export function useWorkflowMoves(orgId: string, projectId: string) {
  const { data } = useQuery({
    queryKey: useOrgQueryKey("workflow-moves", projectId),
    queryFn: () =>
      jsonFetch<{ default: MoveMap; byType: Record<string, MoveMap> }>(
        `/api/v1/orgs/${orgId}/projects/${projectId}/workflow/moves`,
      ),
    retry: false,
    staleTime: 60_000,
  });
  return useCallback(
    (workItemTypeId: string, status: string): ReadonlySet<string> | null => {
      if (!data) return null;
      const map = workItemTypeId in data.byType ? data.byType[workItemTypeId] : data.default;
      return map ? new Set(map[status] ?? []) : null;
    },
    [data],
  );
}
