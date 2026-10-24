"use client";

import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import type { AvailableTransition } from "@/lib/workflow/contract";

/**
 * The transitions the signed-in person may take on an item from its current
 * status, by destination status key. Null until known (and on an error):
 * callers then offer every status and let the server decide, which it does
 * either way.
 */
export function useItemTransitions(
  orgId: string,
  projectId: string,
  itemId: string | undefined,
  columnKey: string | undefined,
): ReadonlyMap<string, AvailableTransition> | null {
  // Keyed on the status too: a move changes what comes next.
  const key = useOrgQueryKey("work-item-transitions", itemId, columnKey);
  const { data } = useQuery({
    queryKey: key,
    queryFn: () =>
      jsonFetch<AvailableTransition[]>(`/api/v1/orgs/${orgId}/projects/${projectId}/work-items/${itemId}/transitions`),
    enabled: Boolean(itemId),
    retry: false,
    select: (list) => (Array.isArray(list) ? new Map(list.map((t) => [t.to, t])) : null),
  });
  return data ?? null;
}
