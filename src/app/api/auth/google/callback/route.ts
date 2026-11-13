import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/db/client";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth/client";
import { getGoogleLoginClient, googleRedirectUri, resolveGoogleLoginCreds } from "@/lib/auth/google-oauth";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { consumePendingInvitations } from "@/lib/auth/consume-invitations";
import { resolveFirstPartyUser } from "@/lib/auth/first-party-identity";
import { storeGoogleRefreshToken } from "@/lib/integrations/google";
import { connectIntent, finishConnect } from "@/lib/auth/connect-flow";

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
  let emailVerified = false;
  let googleId: string | null = null;
  let displayName = "";
  let avatarUrl: string | null = null;
  let refreshToken: string | null = null;

  try {
    const { clientId: googleClientId } = await resolveGoogleLoginCreds();
    // Same per-request redirect the auth-start used — Google requires the token
    // exchange redirect_uri to match the authorization request's (both derive from
    // this request's public origin, i.e. the same domain, so they always agree).
    const googleClient = await getGoogleLoginClient(googleRedirectUri(request));
    const { tokens } = await googleClient.getToken(code);
    if (!tokens.id_token) {
      const res = redirectToLogin(origin, "auth_failed");
      res.cookies.delete(OAUTH_STATE_COOKIE);
      return res;
    }
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: googleClientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub) {
      const res = redirectToLogin(origin, "auth_failed");
      res.cookies.delete(OAUTH_STATE_COOKIE);
      return res;
    }
    email = payload.email.toLowerCase();
    // Strictly `true`: Google documents that an account's address can be
    // unverified, and only a verified one may link an existing account.
    emailVerified = payload.email_verified === true;
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

  // Connecting Google to the signed-in account (Profile, Sign-in methods), not
  // signing in: bind this subject to that account, by the person's own request.
  const connect = connectIntent(request, "google", state);
  if (connect) {
    const token = refreshToken;
    return finishConnect(request, connect, { provider: "google", subject: googleId }, {
      stateCookie: OAUTH_STATE_COOKIE,
      afterConnect: token ? (uid) => storeGoogleRefreshToken(uid, token) : undefined,
    });
  }

  // The Google subject decides. Email links a FIRST sign-in to an existing
  // account only when Google verified it, the account has no Google identity yet
  // and was not created by an organization's SSO. The allowlist (ALLOWED_EMAILS
  // plus the allowed_emails table) applies inside resolveFirstPartyUser.
  const resolved = await resolveFirstPartyUser({
    identity: { provider: "google", subject: googleId },
    verifiedEmails: emailVerified ? [email] : [],
    profile: { displayName, avatarUrl },
  });
  if (!resolved.ok) {
    console.warn(`[auth:google] sign-in refused: ${resolved.reason}`);
    const res = redirectToLogin(origin, resolved.reason);
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  }
  const user = resolved.user;
  // From here on the ACCOUNT's address, not whatever the token carries today.
  email = user.email;

  // An org that requires single sign-on is enforced where it is opened
  // (getAuthContext, lib/auth/org-session-scope), not here: this session still
  // opens the person's other orgs, and that org refuses it.

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
      // The session counts for system admin only through the bound Google
      // identity (see lib/internal/access).
      authMethod: "google",
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
