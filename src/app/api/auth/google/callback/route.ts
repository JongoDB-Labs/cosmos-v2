import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/db/client";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  googleClient,
} from "@/lib/auth/client";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { consumePendingInvitations } from "@/lib/auth/consume-invitations";
import { googleLoginBlockedByGovSso } from "@/lib/auth/sso-enforcement";
import { storeGoogleRefreshToken } from "@/lib/integrations/google";

function redirectToLogin(origin: string, error: string) {
  return NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(error)}`, origin),
  );
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  // Use the public origin from forwarded headers — `url.origin` would be the
  // internal bind hostname (localhost:3000), breaking redirects behind nginx.
  const origin = getPublicOrigin(request);

  // Brake brute-force callback hits per IP — 10/minute, 1/sec sustained.
  const rl = rateLimit(getRateLimitKey(request, "auth.callback"), {
    capacity: 10,
    refillPerSecond: 1,
  });
  if (!rl.allowed) {
    return redirectToLogin(origin, "rate_limited");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;

  if (!code || !state || !cookieState || state !== cookieState) {
    const res = redirectToLogin(origin, "invalid_state");
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  }

  let email: string | null = null;
  let googleId: string | null = null;
  let displayName = "";
  let avatarUrl: string | null = null;
  let refreshToken: string | null = null;

  try {
    const { tokens } = await googleClient.getToken(code);
    if (!tokens.id_token) {
      const res = redirectToLogin(origin, "auth_failed");
      res.cookies.delete(OAUTH_STATE_COOKIE);
      return res;
    }
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub) {
      const res = redirectToLogin(origin, "auth_failed");
      res.cookies.delete(OAUTH_STATE_COOKIE);
      return res;
    }
    email = payload.email.toLowerCase();
    googleId = payload.sub;
    displayName = payload.name ?? email.split("@")[0];
    avatarUrl = payload.picture ?? null;
    // Google only returns a refresh_token on first consent or when
    // prompt=consent forces re-consent. Capture it when present so we can
    // call Calendar/Drive/Gmail on behalf of the user later.
    refreshToken = tokens.refresh_token ?? null;
  } catch {
    const res = redirectToLogin(origin, "auth_failed");
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  }

  // Allowlist check. ALLOWED_EMAILS env var (comma-separated) acts as a
  // permanent bootstrap allowlist on top of the DB-managed allowed_emails table.
  const envAllowed = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const isEnvAllowed = envAllowed.includes(email);
  const dbAllowed = isEnvAllowed
    ? true
    : Boolean(await prisma.allowedEmail.findUnique({ where: { email } }));
  if (!dbAllowed) {
    const res = redirectToLogin(origin, "not_allowed");
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  }

  // Find or create the user. Prefer match by googleId, then by email.
  let user = await prisma.user.findUnique({ where: { googleId } });
  if (!user) {
    const existingByEmail = await prisma.user.findFirst({ where: { email } });
    if (existingByEmail) {
      user = await prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          googleId,
          displayName: existingByEmail.displayName || displayName,
          avatarUrl: avatarUrl ?? existingByEmail.avatarUrl,
          lastActiveAt: new Date(),
          // NOTE: the refresh token is NO LONGER written to the plaintext
          // googleRefreshToken column. It is sealed into the connector
          // credential vault below (after org membership is resolved).
        },
      });
    } else {
      user = await prisma.user.create({
        data: {
          email,
          googleId,
          displayName,
          avatarUrl,
          lastActiveAt: new Date(),
        },
      });
    }
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        lastActiveAt: new Date(),
        ...(avatarUrl ? { avatarUrl } : {}),
      },
    });
  }

  // GOV SSO-enforcement guard (the bypass fix). If this identity belongs to a
  // GOV org with an enabled+enforced IdpConnection, Google login is rejected —
  // gov members MUST authenticate via the IdP (which asserts the MFA/AAL floor),
  // not via Google. INTERNAL_ADMINS platform owners are exempt (break-glass:
  // the interim gov-lockout recovery path; see HANDOFF.md + SSP §3.5).
  if (await googleLoginBlockedByGovSso({ email, userId: user.id })) {
    const res = redirectToLogin(origin, "sso_enforced");
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  }

  // Consume any pending, unexpired invitations addressed to this email —
  // creates the membership (+ invite-time work-roles) and joins #general, so an
  // invited user lands in their org instead of the empty /onboarding screen.
  await consumePendingInvitations(user.id, email);

  // Seal the Google refresh token into the connector credential vault (NOT the
  // plaintext googleRefreshToken column) — protect-at-rest (SC-28 / 3.13.16).
  // Scoped to the user's primary org; resolved AFTER invite consumption so a
  // just-joined org is eligible. Best-effort: a brand-new self-serve signup with
  // no org yet gets sealed on first authenticated tool use (the self-heal path).
  // Never block login on this.
  if (refreshToken) {
    try {
      await storeGoogleRefreshToken(user.id, refreshToken);
    } catch (err) {
      console.warn(
        "[google] failed to seal refresh token at callback (will self-heal on first use)",
        { userId: user.id },
        err instanceof Error ? err.message : err,
      );
    }
  }

  const sessionId = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  await prisma.session.create({
    data: {
      id: sessionId,
      userId: user.id,
      expiresAt,
    },
  });

  const response = NextResponse.redirect(new URL("/", origin));
  response.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}
