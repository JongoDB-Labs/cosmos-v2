import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import type { WebhookDeliveryStatus } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string; webhookId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, webhookId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.WEBHOOK_MANAGE);

    const webhook = await prisma.webhook.findFirst({
      where: { id: webhookId, orgId },
    });
    if (!webhook) return new Response("Not found", { status: 404 });

    const limitParam = request.nextUrl.searchParams.get("limit");
    const statusParam = request.nextUrl.searchParams.get("status");

    const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 200);

    const deliveries = await prisma.webhookDelivery.findMany({
      where: {
        webhookId,
        ...(statusParam ? { status: statusParam as WebhookDeliveryStatus } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return success(deliveries);
  } catch (error) {
    return handleApiError(error);
  }
}
