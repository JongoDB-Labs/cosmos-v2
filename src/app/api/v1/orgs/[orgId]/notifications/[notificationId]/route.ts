import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { success, noContent, handleApiError } from "@/lib/api-helpers";
import { z } from "zod";

const updateNotificationSchema = z.object({
  read: z.boolean(),
});

type RouteParams = {
  params: Promise<{ orgId: string; notificationId: string }>;
};

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, notificationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.notification.findFirst({
      where: { id: notificationId, orgId, userId: ctx.userId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: NOTIFICATION_READ bitfield check + any narrowing
    // deny policy. Notification.userId is the recipient/owner. Identical to
    // requirePermission until a policy exists.
    await requireAccess(ctx, "NOTIFICATION_READ", { ownerId: existing.userId });

    const body = await request.json();
    const data = updateNotificationSchema.parse(body);

    const updated = await prisma.notification.update({
      where: { id: notificationId },
      data: { read: data.read },
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, notificationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.notification.findFirst({
      where: { id: notificationId, orgId, userId: ctx.userId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: NOTIFICATION_READ bitfield check + any narrowing
    // deny policy. Notification.userId is the recipient/owner. Identical to
    // requirePermission until a policy exists.
    await requireAccess(ctx, "NOTIFICATION_READ", { ownerId: existing.userId });

    await prisma.notification.delete({ where: { id: notificationId } });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
