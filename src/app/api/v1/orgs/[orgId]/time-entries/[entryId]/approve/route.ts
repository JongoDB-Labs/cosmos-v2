import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const approveSchema = z.object({
  action: z.enum(["approve", "reject"]),
});

type RouteParams = { params: Promise<{ orgId: string; entryId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_APPROVE);

    const existing = await prisma.timeEntry.findFirst({
      where: { id: entryId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    if (existing.status !== "SUBMITTED") {
      return new Response(
        JSON.stringify({ error: "Only submitted entries can be approved or rejected" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json();
    const data = approveSchema.parse(body);

    const newStatus = data.action === "approve" ? "APPROVED" : "REJECTED";

    const updated = await prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        status: newStatus,
        approvedById: ctx.userId,
        approvedAt: new Date(),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: `time_entry.${data.action}d`,
      entity: "time_entry",
      entityId: entryId,
      metadata: { action: data.action, previousStatus: existing.status } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
