import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

// ─── GET /channels/browse — public channels user is not yet in ───────────
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const channels = await prisma.chatChannel.findMany({
      where: {
        orgId,
        kind: "CHANNEL",
        isPrivate: false,
        archivedAt: null,
        members: { none: { userId: ctx.userId } },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        topic: true,
        lastMessageAt: true,
        _count: { select: { members: true } },
      },
      orderBy: { lastMessageAt: "desc" },
    });

    return success({ channels });
  } catch (e) {
    return handleApiError(e);
  }
}
