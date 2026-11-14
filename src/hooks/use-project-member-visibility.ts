"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { orgQueryKey, useOrgQueryKey } from "@/lib/query/keys";

type Row = { userId: string; canSee: boolean };

const KEY = "project-member-visibility";
const url = (orgId: string, projectId: string) => `/api/v1/orgs/${orgId}/projects/${projectId}/member-visibility`;
const cantSeeOf = (rows: Row[]): ReadonlySet<string> => new Set(rows.filter((r) => !r.canSee).map((r) => r.userId));

/**
 * The members who can't see this project's work items, as the server judges
 * each of them: the rule that decides whether they're told about one. Null
 * until known, and for someone the server won't answer (who can't change
 * items here): no marks then, rather than wrong ones.
 */
export function useMembersWhoCantSeeProject(orgId: string, projectId: string, enabled = true): ReadonlySet<string> | null {
  const { data } = useQuery({
    queryKey: useOrgQueryKey(KEY, projectId),
    queryFn: () => jsonFetch<Row[]>(url(orgId, projectId)),
    enabled: enabled && Boolean(projectId),
    retry: false,
    staleTime: 60_000,
    select: cantSeeOf,
  });
  return data ?? null;
}

/**
 * The same answer outside a component (a row menu that has just assigned
 * someone), from the same cache. Null when it can't be had: say nothing
 * rather than guess.
 */
export async function fetchMembersWhoCantSeeProject(
  qc: QueryClient,
  orgSlug: string,
  orgId: string,
  projectId: string,
): Promise<ReadonlySet<string> | null> {
  try {
    const rows = await qc.fetchQuery({ queryKey: orgQueryKey(orgSlug, KEY, projectId), queryFn: () => jsonFetch<Row[]>(url(orgId, projectId)), staleTime: 60_000 });
    return cantSeeOf(rows);
  } catch {
    return null;
  }
}
