import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/db/client";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth/client";

/**
 * Test-only sign-in. Disabled unless E2E_TEST_AUTH === "1" in the runtime env.
 *
 * Body: { email: string }
 * Side effect: looks up the user by email and creates a fresh Session row,
 * setting the session cookie on the response. Returns the session id in the
 * body for debugging.
 *
 * Do NOT use in production. Do NOT ship without the env-gate.
 */
export async function POST(req: NextRequest) {
  // Belt-and-suspenders production guard (spec §8 gate 8): this auth-bypass
  // route is inert in prod even if E2E_TEST_AUTH leaks into the prod env. The
  // hard NODE_ENV check sits ABOVE the env-gate so a misconfigured prod image
  // can never mint a session here.
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  if (process.env.E2E_TEST_AUTH !== "1") {
    return new Response("Disabled", { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const email: string | undefined = body?.email;
  if (!email) {
    return new Response("Bad Request", { status: 400 });
  }

  const user = await prisma.user.findFirst({ where: { email } });
  if (!user) {
    return new Response(JSON.stringify({ error: "no_such_user" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  // Match the session ID format used by the real OAuth callback: 32 random
  // bytes encoded as a 64-char hex string (not a UUID).
  const sessionId = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  await prisma.session.create({
    data: {
      id: sessionId,
      userId: user.id,
      expiresAt,
    },
  });

  const res = new Response(JSON.stringify({ sessionId, userId: user.id }), {
    headers: { "content-type": "application/json" },
  });
  res.headers.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
  );
  return res;
}
