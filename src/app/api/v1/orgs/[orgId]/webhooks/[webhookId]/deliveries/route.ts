import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { refuseProjectScopedKey } from "@/lib/auth/key-gate";
import { success, handleApiError } from "@/lib/api-helpers";
import type { WebhookDeliveryStatus } from "@prisma/client";
import { DELIVERY_SELECT, toDeliveryDto } from "@/lib/webhooks/dto";
import { readableDeliveriesWhere } from "@/lib/webhooks/access.server";

type RouteParams = { params: Promise<{ orgId: string; webhookId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, webhookId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // A webhook is sent events from every project in the org, so a key limited
    // to some projects can't manage one, whatever its scopes.
    refuseProjectScopedKey(ctx);
    await requireAccess(ctx, "WEBHOOK_MANAGE");
    // The log holds event payloads from every project: reading it needs
    // ITEM_READ too, and shows only projects the caller can read.
    await requireAccess(ctx, "ITEM_READ");
    const readable = await readableDeliveriesWhere(ctx);
    if (!readable) return new Response("Forbidden", { status: 403 });

    const webhook = await prisma.webhook.findFirst({
      where: { id: webhookId, orgId },
      select: { id: true },
    });
    if (!webhook) return new Response("Not found", { status: 404 });

    const limitParam = request.nextUrl.searchParams.get("limit");
    const statusParam = request.nextUrl.searchParams.get("status");

    const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 200);

    const deliveries = await prisma.webhookDelivery.findMany({
      where: {
        webhookId,
        ...(statusParam ? { status: statusParam as WebhookDeliveryStatus } : {}),
        ...readable,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: DELIVERY_SELECT,
    });

    return success(deliveries.map(toDeliveryDto));
  } catch (error) {
    return handleApiError(error);
  }
}
