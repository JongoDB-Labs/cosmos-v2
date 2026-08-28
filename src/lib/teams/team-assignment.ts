import { prisma } from "@/lib/db/client";

/**
 * Is this a team the project may assign work to?
 *
 * `WorkItem.teamId` is only FK-constrained to `teams`, so the database alone
 * would happily let one project's item be assigned to another project's — or
 * another ORG's — team. That is a tenancy leak dressed up as a typo: the team
 * name would then render on a board it does not belong to, and the item would
 * vanish from the team filter of the project that owns it.
 *
 * So the scope is checked here, on the way in, by the two routes that write the
 * field. Shared rather than inlined twice, because a check that exists on create
 * and not on update is the same hole with extra steps.
 */
export async function teamBelongsToProject(
  teamId: string,
  orgId: string,
  projectId: string,
): Promise<boolean> {
  const team = await prisma.team.findFirst({
    where: { id: teamId, orgId, projectId },
    select: { id: true },
  });
  return team !== null;
}
