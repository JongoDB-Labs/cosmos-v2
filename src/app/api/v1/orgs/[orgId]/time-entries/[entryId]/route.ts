import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { BillableType } from "@prisma/client";

const updateTimeEntrySchema = z.object({
  date: z.string().nullish(),
  hours: z.number().positive().optional(),
  rate: z.number().optional(),
  client: z.string().nullish(),
  projectId: z.string().uuid().nullish(),
  workItemId: z.string().uuid().nullish(),
  description: z.string().nullish(),
  billableType: z.nativeEnum(BillableType).optional(),
  tags: z.array(z.string()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string; entryId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);

    const entry = await prisma.timeEntry.findFirst({
      where: { id: entryId, orgId },
    });

    if (!entry) return new Response("Not found", { status: 404 });

    return success(entry);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
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

    const isAdminOrOwner = ctx.orgRole === "ADMIN" || ctx.orgRole === "OWNER";
    if (!isAdminOrOwner) {
      if (existing.userId !== ctx.userId) {
        return new Response(
          JSON.stringify({ error: "You can only update your own time entries" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      if (existing.status !== "DRAFT") {
        return new Response(
          JSON.stringify({ error: "Only draft entries can be updated" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const body = await request.json();
    const data = updateTimeEntrySchema.parse(body);

    const updated = await prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        ...(data.date !== undefined && data.date !== null && { date: new Date(data.date) }),
        ...(data.hours !== undefined && { hours: data.hours }),
        ...(data.rate !== undefined && { rate: data.rate }),
        ...(data.client !== undefined && { client: data.client }),
        ...(data.projectId !== undefined && { projectId: data.projectId }),
        ...(data.workItemId !== undefined && { workItemId: data.workItemId }),
        ...(data.description !== undefined && { description: data.description ?? "" }),
        ...(data.billableType !== undefined && { billableType: data.billableType }),
        ...(data.tags !== undefined && { tags: data.tags }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "time_entry.updated",
      entity: "time_entry",
      entityId: entryId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
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

    // Resource-aware authz: TIME_DELETE bitfield check + any narrowing deny
    // policy. TimeEntry ownership is userId. Identical to requirePermission
    // until a policy exists.
    await requireAccess(ctx, "TIME_DELETE", { ownerId: existing.userId });

    if (existing.status !== "DRAFT") {
      return new Response(
        JSON.stringify({ error: "Only draft entries can be deleted" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const isAdminOrOwner = ctx.orgRole === "ADMIN" || ctx.orgRole === "OWNER";
    if (existing.userId !== ctx.userId && !isAdminOrOwner) {
      return new Response(
        JSON.stringify({ error: "You can only delete your own time entries" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    await prisma.timeEntry.delete({ where: { id: entryId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "time_entry.deleted",
      entity: "time_entry",
      entityId: entryId,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
