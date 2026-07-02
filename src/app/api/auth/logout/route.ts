import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { SESSION_COOKIE } from "@/lib/auth/client";
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
  return response;
}

export async function POST(request: NextRequest) {
  return clearSession(request);
}

export async function GET(request: NextRequest) {
  return clearSession(request);
}
