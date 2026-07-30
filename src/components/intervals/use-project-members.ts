"use client";

import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import type { ProjectMemberRow } from "@/lib/intervals/allocatable-members";

/**
 * The people ON a project, for surfaces that plan human work.
 *
 * Deliberately NOT `useOrgMembers` (components/chat/mention-typeahead.tsx),
 * which the capacity dialogs used to call. That hook is right for the @-mention
 * typeahead — every org member, bots included — and wrong for capacity, where
 * it offered the whole org and invited an allocation for the Foreman agent.
 *
 * Key flows through `useOrgQueryKey` so switching orgs serves a different cache
 * namespace (multi-tenant cache isolation).
 */
export function useProjectMembers(orgId: string, projectId: string) {
  const key = useOrgQueryKey("project-members", projectId);
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<ProjectMemberRow[]> => {
      const r = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}/members`);
      if (!r.ok) throw new Error("Failed to load project members");
      const body = await r.json();
      const raw: unknown = Array.isArray(body) ? body : (body?.data ?? body?.members ?? []);
      if (!Array.isArray(raw)) return [];
      return raw.map((m): ProjectMemberRow => {
        const row = m as Partial<ProjectMemberRow> & { userId?: string };
        return {
          id: String(row.id ?? ""),
          userId: String(row.userId ?? ""),
          displayName: row.displayName ?? row.email ?? "User",
          email: row.email ?? "",
          avatarUrl: row.avatarUrl ?? null,
          // Default to NOT a bot only when the field is genuinely absent (an
          // older server). A present `true` must never be softened away — this
          // flag is what keeps an agent out of capacity planning.
          isBot: row.isBot === true,
          teamIds: Array.isArray(row.teamIds) ? row.teamIds : [],
        };
      });
    },
    staleTime: 60_000,
  });
}
