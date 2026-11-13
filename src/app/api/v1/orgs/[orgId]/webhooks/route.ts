import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { refuseProjectScopedKey } from "@/lib/auth/key-gate";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { randomBytes } from "crypto";
import { auditableUrl, webhookUrlSchema } from "@/lib/security/webhook-url";
import { sealField } from "@/lib/crypto/field-seal";
import { WEBHOOK_PUBLIC_SELECT } from "@/lib/webhooks/dto";
import { listWebhooks } from "@/lib/webhooks/access.server";

const createWebhookSchema = z.object({
  url: webhookUrlSchema,
  events: z.array(z.string().min(1)).min(1),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // A webhook is sent events from every project in the org, so a key limited
    // to some projects can't manage one, whatever its scopes.
    refuseProjectScopedKey(ctx);
    await requireAccess(ctx, "WEBHOOK_MANAGE");

    // Never the sealed `secret`: the plaintext is shown once, at create.
    return success(await listWebhooks(orgId));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // A webhook is sent events from every project in the org, so a key limited
    // to some projects can't manage one, whatever its scopes.
    refuseProjectScopedKey(ctx);
    await requireAccess(ctx, "WEBHOOK_MANAGE");

    const body = await request.json();
    const data = createWebhookSchema.parse(body);

    // The signing secret is generated once and SEALED at rest (3.13.16): the DB
    // column holds the vault envelope, never the plaintext HMAC key. We return the
    // plaintext ONCE in this create response so the caller can configure their
    // consumer. No later read or edit returns it, sealed or open.
    const secret = randomBytes(32).toString("hex");

    const webhook = await prisma.webhook.create({
      data: {
        orgId,
        url: data.url,
        events: data.events,
        secret: sealField(secret),
        active: true,
        // It acts for whoever created it (the person behind a key, for a key):
        // events are sent only from projects they can read.
        createdById: ctx.userId,
      },
      select: WEBHOOK_PUBLIC_SELECT,
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "webhook.created",
      entity: "webhook",
      entityId: webhook.id,
      metadata: { url: auditableUrl(data.url) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Return the PLAINTEXT secret once (so the caller can configure their consumer);
    // the persisted column holds only the sealed envelope.
    return created({ ...webhook, secret, pausedReason: null });
  } catch (error) {
    return handleApiError(error);
  }
}
