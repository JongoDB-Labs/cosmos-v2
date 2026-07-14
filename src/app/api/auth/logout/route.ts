import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { SKIN_COOKIE } from "@/lib/theme/cookie";
import { getPublicOrigin } from "@/lib/auth/public-url";

async function clearSession(request: NextRequest) {
  const sessionId = request.cookies.get(SESSION_COOKIE)?.value;
  if (sessionId) {
    await prisma.session
      .delete({ where: { id: sessionId } })
      .catch(() => undefined);
  }
  // 303 See Other (NOT the default 307): logout is called via `fetch(…, POST)`,
  // and a 307 preserves the method, so the fetch re-issues POST /login → 405
  // (a page route is GET-only). 303 forces the redirect to GET /login.
  const response = NextResponse.redirect(
    new URL("/login", getPublicOrigin(request)),
    303,
  );
  response.cookies.delete(SESSION_COOKIE);
  // Skin is a USER-scoped preference (UserPreferences.skinId); the `skin`
  // cookie is only a device-level first-paint cache (see apply-saved-skin.tsx).
  // On a shared/kiosk browser that cache must not leak into the next person's
  // session, so it's cleared here alongside the session cookie — the next
  // sign-in reseeds it from that user's own resolution.
  response.cookies.delete(SKIN_COOKIE);
  return response;
}

export async function POST(request: NextRequest) {
  return clearSession(request);
}

export async function GET(request: NextRequest) {
  return clearSession(request);
}
