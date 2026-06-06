import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };

const schema = z.object({
  notificationPref: z.enum(["ALL", "MENTIONS", "MUTED"]).optional(),
  mutedUntil: z.string().datetime().nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    // Ensure the channel belongs to the right org before letting the user mutate their membership.
    const channel = await prisma.chatChannel.findUnique({
      where: { id: channelId },
      select: { orgId: true },
    });
    if (!channel || channel.orgId !== orgId) return new Response("Not found", { status: 404 });

    const updated = await prisma.chatChannelMember
      .update({
        where: { channelId_userId: { channelId, userId: ctx.userId } },
        data: {
          ...(parsed.data.notificationPref !== undefined && {
            notificationPref: parsed.data.notificationPref,
          }),
          ...(parsed.data.mutedUntil !== undefined && {
            mutedUntil: parsed.data.mutedUntil ? new Date(parsed.data.mutedUntil) : null,
          }),
        },
      })
      .catch(() => null);

    if (!updated) {
      return new Response(JSON.stringify({ error: "not_a_member" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    return success({
      notificationPref: updated.notificationPref,
      mutedUntil: updated.mutedUntil,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
