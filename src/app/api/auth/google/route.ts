import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { OAUTH_STATE_COOKIE } from "@/lib/auth/client";
import { googleSignInUrl } from "@/lib/auth/google-oauth";
import { CONNECT_COOKIE } from "@/lib/auth/connect-sign-in";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { RETURN_TO_PARAM, loginUrl, rememberReturnTo } from "@/lib/auth/return-to";

export async function GET(request: NextRequest) {
  const rl = rateLimit(getRateLimitKey(request, "auth.start"), {
    capacity: 15,
    refillPerSecond: 1,
  });
  if (!rl.allowed) {
    return NextResponse.redirect(
      loginUrl(getPublicOrigin(request), {
        error: "rate_limited",
        returnTo: request.nextUrl.searchParams.get(RETURN_TO_PARAM),
      }),
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
  // Where to land once the callback has signed the visitor in.
  rememberReturnTo(response, request);
  return response;
}
