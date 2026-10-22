import { prisma } from "@/lib/db/client";

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
