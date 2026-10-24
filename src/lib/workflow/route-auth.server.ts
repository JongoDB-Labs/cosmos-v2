/**
 * What every workflow-editor route checks before its own permission gate: the
 * org exists, the caller is signed in and (for an API key) holds the scopes the
 * operation's contract names, and the project is the org's. Each handler then
 * gates on its own bit, in its own body, where the scope tests read it:
 * reading needs ITEM_READ on the project; changing needs WORKFLOW_MANAGE or
 * the project's manager (which a key's role never counts as: roleCountsFor).
 *
 * The org-wide WORKFLOW_MANAGE passes requireProjectManage without a visibility
 * check, as every org-wide bit there does: it is an admin's power over every
 * project, and no API key scope carries it.
 */
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import type { RouteContract } from "@/lib/openapi/contract";
import { orgContext } from "@/lib/openapi/org-context";
import { ProblemError } from "@/lib/openapi/problem";

export async function workflowProjectContext(
  ids: { orgId: string; projectId: string },
  contract: Pick<RouteContract, "scopes">,
): Promise<AuthContext> {
  const { ctx } = await orgContext(ids.orgId, contract);
  const project = await prisma.project.findFirst({ where: { id: ids.projectId, orgId: ids.orgId }, select: { id: true } });
  if (!project) throw new ProblemError(404, "not_found", "Project not found");
  return ctx;
}
