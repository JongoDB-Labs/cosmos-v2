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
  const response = NextResponse.redirect(
    new URL("/login", getPublicOrigin(request)),
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
