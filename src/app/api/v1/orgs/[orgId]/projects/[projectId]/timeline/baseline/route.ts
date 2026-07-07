import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * Set the Gantt baseline (FR gantt-enh): freeze every dated item's CURRENT
 * start/due into its baseline_start/baseline_end. The timeline then draws a
 * ghost bar from the baseline behind the live bar so slippage is visible.
 * Re-running overwrites the baseline (a fresh snapshot). Gated on ITEM_UPDATE.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "ITEM_UPDATE", { projectId });

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    // Column-to-column copy for every dated item — one statement, no per-row loop.
    const updated = await prisma.$executeRaw`
      UPDATE work_items
         SET baseline_start = start_date,
             baseline_end   = due_date
       WHERE org_id = ${orgId}::uuid
         AND project_id = ${projectId}::uuid
         AND (start_date IS NOT NULL OR due_date IS NOT NULL)`;

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "timeline.baseline_set",
      entity: "project",
      entityId: projectId,
      metadata: { items: String(updated) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ baselined: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
