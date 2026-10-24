"use client";

import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import type { StatusColumn } from "@/lib/boards/project-statuses";

/** Stable while loading, so effects keyed on the list do not re-run every render. */
const NONE: StatusColumn[] = [];

/**
 * The statuses a project's work can be in: the options for the Status filter
 * and pickers, with each status's category.
 *
 * Read from the project's statuses endpoint. Statuses used to be unioned out of
 * every board's columns here, which left boards that own no columns (Timeline,
 * Roadmap, Calendar) to borrow them and resolved disagreements by "first board
 * wins"; they are one project-level list now. Archived statuses are left out,
 * as pickers should not offer them.
 */
export function useProjectStatuses(orgId: string, projectId: string): StatusColumn[] {
  const key = useOrgQueryKey("statuses", projectId);
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => jsonFetch<StatusColumn[]>(`/api/v1/orgs/${orgId}/projects/${projectId}/statuses`),
  });
  return data ?? NONE;
}
