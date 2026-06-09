import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { getPublicOrigin } from "@/lib/auth/public-url";
import {
  MS_STATE_COOKIE,
  microsoftAuthorizeUrl,
  microsoftConfigured,
  microsoftRedirectUri,
} from "@/lib/auth/microsoft";

/** Begin Microsoft (Entra ID) sign-in: stash a CSRF state cookie and redirect
 *  to the Microsoft authorize endpoint. */
export async function GET(request: NextRequest) {
  const origin = getPublicOrigin(request);

  if (!microsoftConfigured()) {
    return NextResponse.redirect(
      new URL("/login?error=ms_not_configured", origin),
    );
  }

  const rl = rateLimit(getRateLimitKey(request, "auth.start"), {
    capacity: 15,
    refillPerSecond: 1,
  });
  if (!rl.allowed) {
    return NextResponse.redirect(new URL("/login?error=rate_limited", origin));
  }

  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = microsoftAuthorizeUrl({
    state,
    redirectUri: microsoftRedirectUri(request),
  });

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(MS_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 5 * 60,
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
