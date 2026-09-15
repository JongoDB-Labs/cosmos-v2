"use client";

import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";

export interface ProjectTeamMember {
  userId: string;
  displayName: string;
  /** `TeamMember.isLead` — a team lead, distinct from a project MANAGER. */
  isLead: boolean;
}

export interface ProjectTeam {
  id: string;
  name: string;
  key: string | null;
  members: ProjectTeamMember[];
}

/**
 * The teams in a project, with their members.
 *
 * Used wherever a ceremony needs to be about ONE squad rather than the whole
 * project. Membership is read from here rather than from `ProjectMemberRow.teamIds`
 * on purpose: that field is a projection that an older server may not populate,
 * and a member list that silently loses its team ids would widen a scoped
 * ceremony back to the entire project — which is the failure this is meant to
 * prevent, arriving quietly.
 */
export function useProjectTeams(orgId: string, projectId: string) {
  const key = useOrgQueryKey("project-teams", projectId);
  return useQuery({
    queryKey: key,
    enabled: Boolean(orgId && projectId),
    queryFn: async (): Promise<ProjectTeam[]> => {
      const r = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}/teams`);
      if (!r.ok) throw new Error("Failed to load teams");
      const body = await r.json();
      const raw: unknown = Array.isArray(body) ? body : (body?.data ?? []);
      if (!Array.isArray(raw)) return [];
      return raw.map((t) => {
        const row = t as Partial<ProjectTeam>;
        return {
          id: String(row.id ?? ""),
          name: row.name ?? "Team",
          key: row.key ?? null,
          members: Array.isArray(row.members)
            ? row.members.map((m) => ({
                userId: String(m.userId ?? ""),
                displayName: m.displayName ?? "User",
                isLead: m.isLead === true,
              }))
            : [],
        };
      });
    },
    staleTime: 60_000,
  });
}
