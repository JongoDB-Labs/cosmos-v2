/**
 * The checks every workflow-editor route makes: the org exists, the caller is
 * signed in, the project is the org's, and the caller may read (anyone who can
 * read the project's items) or manage (WORKFLOW_MANAGE, or the project's
 * manager) its workflows. An API key manages none: no scope grants the bit,
 * and a key's project role doesn't count for it (roleCountsFor).
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import type { AuthContext } from "@/lib/rbac/check";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { problem } from "@/lib/openapi/problem";

export type WorkflowRouteAccess = "read" | "manage";

/** The caller's context, or the problem response to return instead. */
export async function workflowProjectContext(
  request: NextRequest,
  ids: { orgId: string; projectId: string },
  access: WorkflowRouteAccess,
): Promise<{ ctx: AuthContext } | { response: Response }> {
  const org = await prisma.organization.findUnique({ where: { id: ids.orgId }, select: { slug: true } });
  if (!org) return { response: problem(404, "not_found", "Organization not found", { request }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { response: problem(401, "unauthorized", undefined, { request }) };
  const project = await prisma.project.findFirst({ where: { id: ids.projectId, orgId: ids.orgId }, select: { id: true } });
  if (!project) return { response: problem(404, "not_found", "Project not found", { request }) };
  if (access === "manage") await requireProjectManage(ctx, ids.projectId, Permission.WORKFLOW_MANAGE);
  else await requireProjectRead(ctx, ids.projectId, "ITEM_READ");
  return { ctx };
}

/** The same for org templates: anyone in the org reads them; managing needs the bit itself. */
export async function workflowOrgContext(
  request: NextRequest,
  orgId: string,
  access: WorkflowRouteAccess,
): Promise<{ ctx: AuthContext } | { response: Response }> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
  if (!org) return { response: problem(404, "not_found", "Organization not found", { request }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { response: problem(401, "unauthorized", undefined, { request }) };
  if (access === "manage") requirePermission(ctx, Permission.WORKFLOW_MANAGE);
  return { ctx };
}
