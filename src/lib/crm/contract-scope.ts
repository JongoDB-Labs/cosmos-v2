import type { Prisma } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { canReadInProject } from "@/lib/rbac/require-project-read";

/**
 * Contracts are CRM data, so CRM_READ is the action asked of their project: a
 * rule that denies somebody a project's CRM data denies its contracts, and one
 * about its work items does not. Every door asks the same action.
 */
const CONTRACT_READ = "CRM_READ" as const;

/**
 * The contracts this caller may see, as a `where` for every query that lists them.
 *
 * CRM_READ is held by MEMBER and VIEWER, so it says the caller may read SOME
 * contracts and nothing about WHICH. A contract filed under a project is that
 * project's: on a team-scoped project only its team sees it. A contract under no
 * project is org-level CRM data, visible to any CRM reader, which is how
 * contracts are used today.
 *
 * One fragment, because there are several doors onto the same rows. The
 * contract list asked; a partner's and a product's detail listed every contract
 * with them anyway, with value and terms, and their lists counted them. Each of
 * those now spreads this instead of writing the clause again.
 */
export async function readableContractsWhere(ctx: AuthContext): Promise<Prisma.ContractWhereInput> {
  const readable = await getReadableProjectIds(ctx, CONTRACT_READ);
  return {
    orgId: ctx.orgId,
    OR: [{ projectId: null }, { projectId: { in: readable } }],
  };
}

/**
 * One contract, by id: the same answer `readableContractsWhere` gives in a list.
 * A contract under no project is org-level CRM data and the route's CRM bit is
 * enough; one under a project needs CRM_READ there, rules and team included.
 * Callers answer a "no" with the 404 a missing contract gets, writes included,
 * so a refusal never confirms that the id is real.
 */
export async function mayReadContract(ctx: AuthContext, projectId: string | null): Promise<boolean> {
  return !projectId || canReadInProject(ctx, projectId, CONTRACT_READ);
}
