import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import {
  MS_CALENDAR_CALLBACK_PATH,
  MS_CALENDAR_STATE_COOKIE,
  calendarAuthorizeUrl,
  newConnectState,
} from "@/lib/integrations/microsoft/calendar-connect";
import { orgCalendarConfig } from "@/lib/integrations/microsoft/calendar-token.server";

type RouteParams = { params: Promise<{ orgId: string }> };

/** Start connecting the signed-in person's Outlook Calendar (COSMOS-202 B1). */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const origin = getPublicOrigin(request);
  const org = await prisma.organization.findUnique({ where: { id: (await params).orgId }, select: { id: true, slug: true } });
  if (!org) return new Response("Not found", { status: 404 });
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  const back = (outlook: string) => NextResponse.redirect(new URL(`/${org.slug}/settings/preferences?outlook=${outlook}`, origin));

  if (!rateLimit(getRateLimitKey(request, "ms.calendar.connect", ctx.userId), { capacity: 10, refillPerSecond: 0.1 }).allowed) {
    return back("rate_limited");
  }
  const cfg = await orgCalendarConfig(org.id);
  if (!cfg) return back("not_enabled");

  const s = newConnectState(org.id, ctx.userId);
  const res = NextResponse.redirect(
    calendarAuthorizeUrl({
      clientId: cfg.clientId,
      tenantId: cfg.tenantId,
      redirectUri: `${origin}${MS_CALENDAR_CALLBACK_PATH}`,
      state: s.state,
      challenge: s.challenge,
    }),
  );
  res.cookies.set(MS_CALENDAR_STATE_COOKIE, s.cookie, {
    httpOnly: true,
    sameSite: "lax",
    path: MS_CALENDAR_CALLBACK_PATH,
    maxAge: 10 * 60,
    // Any https deployment, not only NODE_ENV=production ones.
    secure: origin.startsWith("https:"),
  });
  return res;
}
