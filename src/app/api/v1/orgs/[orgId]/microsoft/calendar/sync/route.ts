import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError } from "@/lib/api-helpers";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { CalendarNotConnected, CalendarReconnectNeeded } from "@/lib/integrations/microsoft/calendar-token.server";
import { GraphThrottled } from "@/lib/integrations/microsoft/graph.server";
import { syncUserNow } from "@/lib/integrations/microsoft/calendar-sync.server";

type RouteParams = { params: Promise<{ orgId: string }> };

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });

/** "Sync now" (COSMOS-202 B2): the signed-in person's own calendar only. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    if (!rateLimit(getRateLimitKey(request, "ms.calendar.sync", ctx.userId), { capacity: 3, refillPerSecond: 1 / 60 }).allowed) {
      return json(429, "Synced a moment ago. Try again in a minute.");
    }
    try {
      return success(await syncUserNow(orgId, ctx.userId));
    } catch (e) {
      if (e instanceof CalendarNotConnected) return json(409, "Outlook Calendar isn't connected.");
      if (e instanceof CalendarReconnectNeeded) return json(409, "Reconnect Outlook Calendar first.");
      if (e instanceof GraphThrottled) return json(503, "Microsoft is busy. Try again in a few minutes.");
      throw e;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
