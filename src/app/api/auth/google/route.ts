import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { OAUTH_STATE_COOKIE, googleClient } from "@/lib/auth/client";
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

  const authUrl = googleClient.generateAuthUrl({
    scope: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/gmail.readonly",
      // Required to send invitation emails from the inviter's mailbox.
      "https://www.googleapis.com/auth/gmail.send",
      // Google Meet REST API — create spaces + read conference artifacts.
      "https://www.googleapis.com/auth/meetings.space.created",
      "https://www.googleapis.com/auth/meetings.space.readonly",
    ],
    state,
    access_type: "offline",
    prompt: "consent",
  });

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 5 * 60,
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
