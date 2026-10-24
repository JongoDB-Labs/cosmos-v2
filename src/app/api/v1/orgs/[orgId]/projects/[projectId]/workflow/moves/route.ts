import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { handleApiError, success } from "@/lib/api-helpers";
import { problem } from "@/lib/openapi/problem";
import { allowedMoves } from "@/lib/workflow/engine.server";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return problem(404, "not_found", "Organization not found", { request });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return problem(401, "unauthorized", undefined, { request });
    const project = await prisma.project.findFirst({ where: { id: projectId, orgId }, select: { id: true } });
    if (!project) return problem(404, "not_found", "Project not found", { request });
    await requireProjectRead(ctx, projectId, "ITEM_READ");
    return success(await prisma.$transaction((tx) => allowedMoves(tx, { orgId, projectId, actor: ctx })));
  } catch (error) {
    return handleApiError(error, request);
  }
}
