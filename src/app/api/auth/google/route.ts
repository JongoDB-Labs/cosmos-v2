import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { OAUTH_STATE_COOKIE } from "@/lib/auth/client";
import { googleSignInUrl } from "@/lib/auth/google-oauth";
import { CONNECT_COOKIE } from "@/lib/auth/connect-sign-in";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { getPublicOrigin } from "@/lib/auth/public-url";

export async function GET(request: NextRequest) {
  const rl = rateLimit(getRateLimitKey(request, "auth.start"), {
    capacity: 15,
    refillPerSecond: 1,
  });
  if (!rl.allowed) {
    return NextResponse.redirect(
      new URL("/login?error=rate_limited", getPublicOrigin(request)),
    );
  }

  const state = crypto.randomBytes(16).toString("hex");

  const authUrl = await googleSignInUrl(request, state);

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 5 * 60,
    secure: process.env.NODE_ENV === "production",
  });
  // A sign-in, not a connect: drop any connect request left from an abandoned
  // round trip (its state would not match anyway).
  response.cookies.delete(CONNECT_COOKIE);
  return response;
}
