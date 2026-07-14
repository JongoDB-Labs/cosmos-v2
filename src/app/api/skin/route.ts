import { NextRequest, NextResponse } from "next/server";
import { SKIN_COOKIE, isValidSkinId } from "@/lib/theme/cookie";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";

/**
 * Skin is a USER-scoped preference (UserPreferences.skinId), not a device
 * setting. The `skin` cookie is only a first-paint cache (read by the
 * no-FOUC script in app/layout.tsx and reconciled by apply-saved-skin.tsx) —
 * the DB row is the source of truth, so it's persisted here for the
 * authenticated user in addition to the cookie. Without this, a skin change
 * only lived in this browser's cookie: it wouldn't follow the user across
 * devices, and — worse — a stale cookie left behind by a previous account in
 * the same browser could outlive any of *this* user's own preferences.
 * Unauthenticated calls (no session) fall back to cookie-only, unchanged
 * from prior behavior.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { skin?: unknown };
  const skin = body.skin;
  const user = await getCurrentUser();

  if (skin === null || skin === undefined) {
    if (user) {
      await prisma.userPreferences.upsert({
        where: { userId: user.id },
        create: { userId: user.id, skinId: null },
        update: { skinId: null },
      });
    }
    const response = NextResponse.json({ ok: true });
    response.cookies.delete(SKIN_COOKIE);
    return response;
  }
  if (!isValidSkinId(skin)) {
    return NextResponse.json({ error: "invalid skin" }, { status: 400 });
  }
  if (user) {
    await prisma.userPreferences.upsert({
      where: { userId: user.id },
      create: { userId: user.id, skinId: skin },
      update: { skinId: skin },
    });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SKIN_COOKIE, skin, {
    httpOnly: false, sameSite: "lax", path: "/",
    maxAge: 60 * 60 * 24 * 365, secure: process.env.NODE_ENV === "production",
  });
  return response;
}
