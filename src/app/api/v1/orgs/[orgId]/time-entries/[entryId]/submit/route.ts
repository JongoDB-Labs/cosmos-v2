import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; entryId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.timeEntry.findFirst({
      where: { id: entryId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: TIME_UPDATE bitfield check + any narrowing deny
    // policy. TimeEntry ownership is userId. Identical to requirePermission
    // until a policy exists.
    await requireAccess(ctx, "TIME_UPDATE", { ownerId: existing.userId });

    if (existing.userId !== ctx.userId) {
      return new Response(
        JSON.stringify({ error: "You can only submit your own time entries" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    if (existing.status !== "DRAFT") {
      return new Response(
        JSON.stringify({ error: "Only draft entries can be submitted" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const updated = await prisma.timeEntry.update({
      where: { id: entryId },
      data: { status: "SUBMITTED" },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "time_entry.submitted",
      entity: "time_entry",
      entityId: entryId,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
