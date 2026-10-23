import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { logAudit } from "@/lib/audit";
import { getIpAddress } from "@/lib/api-helpers";
import {
  ADMIN_CONSENT_STATE,
  MS_CALENDAR_CALLBACK_PATH,
  MS_CALENDAR_STATE_COOKIE,
  openConnectState,
} from "@/lib/integrations/microsoft/calendar-connect";
import { CalendarNotConnected, completeCalendarConnect } from "@/lib/integrations/microsoft/calendar-token.server";

/**
 * Microsoft sends the person back here after they consent (COSMOS-202 B1), and
 * a tenant admin back here after granting org-wide consent. The redirect URI
 * the Entra app registers. The sealed state cookie must match, be unexpired,
 * and belong to the person who is signed in now.
 */
export async function GET(request: NextRequest) {
  const origin = getPublicOrigin(request);
  const url = new URL(request.url);
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", origin));

  // The admin-consent round trip carries no code, just a verdict. The slug only
  // picks which settings page to land on; it grants nothing.
  const rawState = url.searchParams.get("state") ?? "";
  if (rawState.startsWith(ADMIN_CONSENT_STATE)) {
    const slug = rawState.slice(ADMIN_CONSENT_STATE.length).replace(/[^a-z0-9-]/gi, "");
    const ok = url.searchParams.get("admin_consent")?.toLowerCase() === "true";
    return NextResponse.redirect(new URL(`/${slug}/settings/integrations?msConsent=${ok ? "granted" : "failed"}`, origin));
  }

  const s = openConnectState(request.cookies.get(MS_CALENDAR_STATE_COOKIE)?.value, url.searchParams.get("state"));
  const done = async (slug: string | null, outlook: string) => {
    const res = NextResponse.redirect(new URL(slug ? `/${slug}/settings/preferences?outlook=${outlook}` : "/", origin));
    res.cookies.set(MS_CALENDAR_STATE_COOKIE, "", { path: MS_CALENDAR_CALLBACK_PATH, maxAge: 0 });
    return res;
  };
  if (!s || s.userId !== user.id) return done(null, "invalid_state");
  const org = await prisma.organization.findUnique({ where: { id: s.orgId }, select: { slug: true } });
  if (!org) return done(null, "invalid_state");
  if (url.searchParams.get("error")) return done(org.slug, "denied");
  const code = url.searchParams.get("code");
  if (!code) return done(org.slug, "invalid_state");

  try {
    const claims = await completeCalendarConnect({
      orgId: s.orgId,
      userId: s.userId,
      code,
      verifier: s.verifier,
      redirectUri: `${origin}${MS_CALENDAR_CALLBACK_PATH}`,
    });
    await logAudit({
      orgId: s.orgId, userId: s.userId, action: "microsoft_calendar.connected", entity: "user", entityId: s.userId,
      metadata: { account: claims.upn } as Record<string, string>, ipAddress: getIpAddress(request),
    });
    return done(org.slug, "connected");
  } catch (e) {
    if (e instanceof CalendarNotConnected) {
      return done(org.slug, /different organization/.test(e.message) ? "wrong_tenant" : "failed");
    }
    console.error("outlook calendar connect failed:", e instanceof Error ? e.message : "unknown error");
    return done(org.slug, "failed");
  }
}
