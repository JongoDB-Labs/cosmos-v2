import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { canPostToChannelGiven, loadChannelAndMembership } from "@/lib/chat/access";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { checkRateLimit } from "@/lib/rate-limit/guard";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };

// Typing is ephemeral — no DB write. The client re-pings while the user keeps
// typing; the indicator expires on the receiver after expiresAt passes.
const TYPING_TTL_MS = 5_000;

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // Generous limit: a fast typist re-pings every ~3s; 30/min/channel is plenty.
    const limited = checkRateLimit(req, "chat.typing", ctx.userId, {
      capacity: 30,
      refillPerSecond: 0.5,
    });
    if (limited) return limited;

    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel) return new Response("Not found", { status: 404 });
    if (!canPostToChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Forbidden", { status: 403 });
    }

    void getBus().publish(topics.channel(channelId), "chat.typing", {
      userId: ctx.userId,
      channelId,
      expiresAt: Date.now() + TYPING_TTL_MS,
    });

    return success({ ok: true });
  } catch (e) {
    return handleApiError(e);
  }
}
