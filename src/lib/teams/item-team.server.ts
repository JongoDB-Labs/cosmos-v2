import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TeamRoster } from "@/lib/query/env";

export const TEAM_NOT_IN_PROJECT_MESSAGE = "That team isn't part of this project.";

/**
 * COSMOS-204: an item's team must be one of its own project's teams. The FK
 * only proves the team exists somewhere, so without this a crafted request
 * could file work under another project's (or another org's) team. Returns the
 * message to reject with, or null when the team is fine or being cleared.
 */
export async function teamProjectError(args: {
  projectId: string;
  teamId: string | null | undefined;
}): Promise<string | null> {
  if (!args.teamId) return null;
  const team = await prisma.team.findFirst({
    where: { id: args.teamId, projectId: args.projectId },
    select: { id: true },
  });
  return team ? null : TEAM_NOT_IN_PROJECT_MESSAGE;
}

/**
 * Every team in these projects, keyed by id, with its project and the user ids
 * on it: the roster half of the team rule (item-teams.ts), for code that asks
 * the database instead of filtering a board's list.
 *
 * Read the way the board's teams route reads it (team -> members -> project
 * member -> org member), so a person removed from the org still counts for the
 * team they were on, exactly as on the board. The query language and the
 * board must give the same answer for the same rows.
 */
export async function loadTeamRosters(
  db: Pick<Prisma.TransactionClient, "team">,
  orgId: string,
  projectIds: string[],
): Promise<Map<string, TeamRoster>> {
  if (projectIds.length === 0) return new Map();
  const teams = await db.team.findMany({
    where: { orgId, projectId: { in: projectIds } },
    select: {
      id: true,
      projectId: true,
      members: { select: { projectMember: { select: { orgMember: { select: { userId: true } } } } } },
    },
  });
  return new Map(
    teams.map((t) => [
      t.id,
      {
        projectId: t.projectId,
        userIds: [...new Set(t.members.map((m) => m.projectMember.orgMember.userId))].sort(),
      },
    ]),
  );
}
