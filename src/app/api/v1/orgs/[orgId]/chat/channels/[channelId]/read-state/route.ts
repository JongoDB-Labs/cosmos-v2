import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { canSeeChannelGiven, loadChannelAndMembership } from "@/lib/chat/access";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };

/**
 * Returns each OTHER member's lastReadMessageId so the client can render
 * read-receipt avatars (excludes the caller — you don't show your own receipt).
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const { channel, member } = await loadChannelAndMembership(channelId, ctx.userId);
    if (!channel) return new Response("Not found", { status: 404 });
    if (!canSeeChannelGiven({ channel, member, viewerOrgId: orgId, orgRole: ctx.orgRole })) {
      return new Response("Not found", { status: 404 });
    }

    const members = await prisma.chatChannelMember.findMany({
      where: { channelId, NOT: { userId: ctx.userId } },
      select: { userId: true, lastReadMessageId: true },
    });

    return success({
      readState: members
        .filter((m) => m.lastReadMessageId !== null)
        .map((m) => ({ userId: m.userId, lastReadMessageId: m.lastReadMessageId })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
