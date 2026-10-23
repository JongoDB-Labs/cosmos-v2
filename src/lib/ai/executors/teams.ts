import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { teamWorkItemWhere } from "@/lib/teams/item-teams";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { assertPermission, assertProjectRead, type ToolContext } from "./_ctx";

/**
 * Team tools (COSMOS-222). Teams are project-scoped, so "what is my team doing"
 * takes two steps: `list_teams` says which of a project's teams the asker is on,
 * then the work-item tools filter by that team's id.
 */

const TEAM_MEMBERS = {
  members: {
    select: { projectMember: { select: { orgMember: { select: { userId: true } } } } },
  },
} as const;

type TeamWithMembers = {
  id: string;
  projectId: string;
  members: { projectMember: { orgMember: { userId: string } } }[];
};

const memberIds = (team: TeamWithMembers) =>
  team.members.map((m) => m.projectMember.orgMember.userId);

// ── list_teams ───────────────────────────────────────────────────────────────
const listSchema = z.object({ projectId: z.string().uuid() });

export async function listTeams(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_READ);
  if (denied) return denied;

  const parsed = listSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const { projectId } = parsed.data;

  const outOfScope = await assertProjectRead(ctx, projectId, "PROJECT_READ");
  if (outOfScope) return outOfScope;

  const teams = await prisma.team.findMany({
    where: { orgId: ctx.orgId, projectId },
    orderBy: { name: "asc" },
    select: { id: true, projectId: true, name: true, key: true, ...TEAM_MEMBERS },
  });

  return {
    count: teams.length,
    teams: teams.map((t) => {
      const ids = memberIds(t);
      return {
        id: t.id,
        projectId: t.projectId,
        name: t.name,
        key: t.key,
        memberCount: ids.length,
        isMine: ids.includes(ctx.userId),
      };
    }),
  };
}

/**
 * Resolve a team-filter argument into a work-item where clause, or an error.
 * The team must sit in one of `projectIds` — the projects the caller already
 * established it may read — so a team id cannot reach into another project.
 */
export async function teamFilter(
  orgId: string,
  teamId: string,
  projectIds: string[],
): Promise<{ where: Prisma.WorkItemWhereInput; projectId: string } | { error: string }> {
  const team = await prisma.team.findFirst({
    where: { id: teamId, orgId, projectId: { in: projectIds } },
    select: { id: true, projectId: true, ...TEAM_MEMBERS },
  });
  if (!team) return { error: "Team not found" };
  return { where: teamWorkItemWhere(team.id, memberIds(team)), projectId: team.projectId };
}
