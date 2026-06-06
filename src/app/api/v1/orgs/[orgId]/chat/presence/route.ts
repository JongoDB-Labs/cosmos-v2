import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { getPresence } from "@/lib/realtime/presence";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Returns the set of currently-online user ids (per this instance's view).
 * The client seeds presence dots from this; live changes arrive via the
 * chat.presence.changed SSE event. Restricted to org members so cross-org
 * presence never leaks.
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const online = getPresence().onlineUserIds();
    if (online.length === 0) return success({ online: [] as string[] });
    const members = await prisma.orgMember.findMany({
      where: { orgId, userId: { in: online } },
      select: { userId: true },
    });
    return success({ online: members.map((m) => m.userId) });
  } catch (e) {
    return handleApiError(e);
  }
}
