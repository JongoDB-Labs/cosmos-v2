import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

const schema = z.object({
  entryIds: z.array(z.string().uuid()).min(1).max(500),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_APPROVE);

    const body = schema.parse(await request.json());

    const result = await prisma.timeEntry.updateMany({
      where: {
        id: { in: body.entryIds },
        orgId: ctx.orgId,
        status: "SUBMITTED",
      },
      data: {
        status: "APPROVED",
        approvedById: ctx.userId,
        approvedAt: new Date(),
      },
    });

    await logAudit({
      orgId: ctx.orgId,
      userId: ctx.userId,
      action: "time_entry.bulk_approved",
      entity: "time_entry",
      entityId: body.entryIds.join(","),
      metadata: {
        count: result.count,
        requestedCount: body.entryIds.length,
      },
      ipAddress: getIpAddress(request),
    });

    return success({ approvedCount: result.count });
  } catch (e) {
    return handleApiError(e);
  }
}
