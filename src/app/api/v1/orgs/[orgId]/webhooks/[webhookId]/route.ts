import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { refuseProjectScopedKey } from "@/lib/auth/key-gate";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { auditableUrl, webhookUrlSchema } from "@/lib/security/webhook-url";
import { DELIVERY_SELECT, WEBHOOK_PUBLIC_SELECT, toDeliveryDto } from "@/lib/webhooks/dto";
import { pausedReasons, readableDeliveriesWhere } from "@/lib/webhooks/access.server";

const updateWebhookSchema = z.object({
  url: webhookUrlSchema.nullish(),
  events: z.array(z.string().min(1)).min(1).optional(),
  active: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; webhookId: string }> };

const EDIT_SELECT = { id: true, url: true, events: true, active: true, createdById: true } as const;

/**
 * What an edit writes, and the audit fields it adds. A webhook acts for its
 * creator (access.server.ts). An edit that changes where its events go or
 * which it sends, or turns it back on, makes it act for the EDITOR from then
 * on: otherwise someone who reads fewer projects could point the creator's
 * webhook at their own URL and receive what only the creator may read.
 */
function applyEdit(
  existing: { url: string; events: string[]; active: boolean; createdById: string | null },
  data: { url?: string | null; events?: string[]; active?: boolean },
  editorId: string,
): { write: Prisma.WebhookUncheckedUpdateInput; audit: Record<string, string> } {
  const write: Prisma.WebhookUncheckedUpdateInput = {};
  if (data.url !== undefined && data.url !== null) write.url = data.url;
  if (data.events !== undefined) write.events = data.events;
  if (data.active !== undefined) write.active = data.active;
  const sameEvents = (a: string[], b: string[]) => a.length === b.length && a.every((e) => b.includes(e));
  const resends =
    (write.url !== undefined && write.url !== existing.url) ||
    (data.events !== undefined && !sameEvents(data.events, existing.events)) ||
    (data.active === true && !existing.active);
  if (!resends || existing.createdById === editorId) return { write, audit: {} };
  write.createdById = editorId;
  return { write, audit: { actsFor: editorId, previouslyActedFor: existing.createdById ?? "" } };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
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

    // Recent deliveries carry event payloads: only those the caller could read
    // from the delivery log itself (ITEM_READ, and a project it can read).
    const readable = await readableDeliveriesWhere(ctx);
    const webhook = await prisma.webhook.findFirst({
      where: { id: webhookId, orgId },
      select: {
        ...WEBHOOK_PUBLIC_SELECT,
        deliveries: { where: readable ?? { id: { in: [] } }, orderBy: { createdAt: "desc" }, take: 20, select: DELIVERY_SELECT },
      },
    });

    if (!webhook) return new Response("Not found", { status: 404 });
    const paused = await pausedReasons(orgId, [webhook]);

    return success({ ...webhook, pausedReason: paused.get(webhook.id) ?? null, deliveries: webhook.deliveries.map(toDeliveryDto) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
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

    const existing = await prisma.webhook.findFirst({
      where: { id: webhookId, orgId },
      select: EDIT_SELECT,
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateWebhookSchema.parse(body);
    const edit = applyEdit(existing, data, ctx.userId);

    const updated = await prisma.webhook.update({
      where: { id: webhookId },
      data: edit.write,
      select: WEBHOOK_PUBLIC_SELECT,
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "webhook.updated",
      entity: "webhook",
      entityId: webhookId,
      metadata: { url: auditableUrl(updated.url), ...edit.audit } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
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

    const existing = await prisma.webhook.findFirst({
      where: { id: webhookId, orgId },
      select: EDIT_SELECT,
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateWebhookSchema.partial().parse(body);
    const edit = applyEdit(existing, data, ctx.userId);

    const updated = await prisma.webhook.update({
      where: { id: webhookId },
      data: edit.write,
      select: WEBHOOK_PUBLIC_SELECT,
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "webhook.patched",
      entity: "webhook",
      entityId: webhookId,
      metadata: { url: auditableUrl(updated.url), ...edit.audit } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
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

    const webhook = await prisma.webhook.findFirst({
      where: { id: webhookId, orgId },
      select: { id: true, url: true },
    });
    if (!webhook) return new Response("Not found", { status: 404 });

    await prisma.webhook.delete({ where: { id: webhookId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "webhook.deleted",
      entity: "webhook",
      entityId: webhookId,
      metadata: { url: auditableUrl(webhook.url) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
