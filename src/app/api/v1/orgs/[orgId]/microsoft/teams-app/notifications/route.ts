import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { teamsAppEnabled } from "@/lib/integrations/microsoft/teams-app/identity.server";
import { NOTIFY_TYPES } from "@/lib/integrations/microsoft/teams-app/outbox.server";

type RouteParams = { params: Promise<{ orgId: string }> };

const bodySchema = z.object({ notifyTypes: z.array(z.enum(NOTIFY_TYPES)).max(NOTIFY_TYPES.length) });

async function resolve(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
  if (!org) return null;
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return null;
  // A person's own notification choices: never on an API key (they'd be the
  // key owner's chat), and only for someone who gets notifications at all.
  if (ctx.isApiKey) return "api_key" as const;
  requirePermission(ctx, Permission.NOTIFICATION_READ);
  return { org, ctx };
}

async function settings(orgId: string, userId: string) {
  const [available, conv] = await Promise.all([
    teamsAppEnabled(orgId),
    prisma.teamsConversation.findUnique({ where: { orgId_userId: { orgId, userId } }, select: { notifyTypes: true } }),
  ]);
  return {
    available,
    chatReady: !!conv,
    notifyTypes: (conv?.notifyTypes ?? []).filter((t): t is (typeof NOTIFY_TYPES)[number] => (NOTIFY_TYPES as readonly string[]).includes(t)),
  };
}

/** The signed-in person's Teams notification choices (COSMOS-202 T2). Their own only. */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const r = await resolve((await params).orgId);
    if (!r) return new Response("Unauthorized", { status: 401 });
    if (r === "api_key") return new Response("Forbidden", { status: 403 });
    return success(await settings(r.org.id, r.ctx.userId));
  } catch (error) {
    return handleApiError(error);
  }
}

/** Choose them. Only once the person has a chat with the bot: there's nowhere to send otherwise. */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const r = await resolve((await params).orgId);
    if (!r) return new Response("Unauthorized", { status: 401 });
    if (r === "api_key") return new Response("Forbidden", { status: 403 });
    const { notifyTypes } = bodySchema.parse(await request.json());
    const s = await settings(r.org.id, r.ctx.userId);
    if (!s.available || !s.chatReady) {
      return Response.json({ error: "Open Cosmos in Teams and send it a message first." }, { status: 409 });
    }
    await prisma.teamsConversation.update({
      where: { orgId_userId: { orgId: r.org.id, userId: r.ctx.userId } },
      data: { notifyTypes: [...new Set(notifyTypes)] },
    });
    return success(await settings(r.org.id, r.ctx.userId));
  } catch (error) {
    return handleApiError(error);
  }
}
