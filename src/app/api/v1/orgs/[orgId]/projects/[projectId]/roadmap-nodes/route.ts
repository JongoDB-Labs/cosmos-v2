import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * GET — list every roadmap node for the project (the client builds the section →
 * child tree). Read-gated on PROJECT_READ; creation/replacement is the dedicated
 * `import` route (PROJECT_UPDATE), so there is no POST here.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "PROJECT_READ");

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const nodes = await prisma.roadmapNode.findMany({
      where: { orgId, projectId },
      orderBy: [{ sortOrder: "asc" }, { externalRef: "asc" }],
    });

    return success(nodes);
  } catch (e) {
    return handleApiError(e);
  }
}
