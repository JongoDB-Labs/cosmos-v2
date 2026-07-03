import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

/**
 * All key-result check-ins across a project, flattened with each KR's objective +
 * owner so the OKR Health view can bucket them into the stoplight-over-time grid
 * (swimlanes × time) and the exec attention panel without extra joins client-side.
 * Ordered oldest→newest so "latest in period" and "confidence delta" are cheap.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_READ);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const rows = await prisma.keyResultCheckin.findMany({
      where: { keyResult: { objective: { orgId, projectId } } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        keyResultId: true,
        value: true,
        confidence: true,
        rag: true,
        note: true,
        blockers: true,
        createdAt: true,
        keyResult: {
          select: {
            objectiveId: true,
            ownerId: true,
            objective: { select: { ownerId: true } },
          },
        },
      },
    });

    const flat = rows.map((r) => ({
      id: r.id,
      keyResultId: r.keyResultId,
      objectiveId: r.keyResult.objectiveId,
      // KR owner if set, else the objective's owner — the swimlane grouping key.
      ownerId: r.keyResult.ownerId ?? r.keyResult.objective.ownerId ?? null,
      value: r.value,
      confidence: r.confidence,
      rag: r.rag,
      note: r.note,
      blockers: r.blockers,
      createdAt: r.createdAt,
    }));

    return success(flat);
  } catch (e) {
    return handleApiError(e);
  }
}
