import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/db/client";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth/client";
import {
  MS_STATE_COOKIE,
  exchangeMicrosoftCode,
  microsoftRedirectUri,
  readMicrosoftIdToken,
  resolveMicrosoftTenantPolicy,
  verifiedMicrosoftEmails,
  type MicrosoftIdClaims,
  type MicrosoftTenantPolicy,
} from "@/lib/auth/microsoft";
import { resolveFirstPartyUser } from "@/lib/auth/first-party-identity";
import { getProviderConfig } from "@/lib/auth/provider-config";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { connectIntent, finishConnect } from "@/lib/auth/connect-flow";
import { connectOutcomeUrl, CONNECT_COOKIE } from "@/lib/auth/connect-sign-in";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { consumePendingInvitations } from "@/lib/auth/consume-invitations";

function redirectToLogin(origin: string, error: string) {
  return NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(error)}`, origin),
  );
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const origin = getPublicOrigin(request);

  const cfg = await getProviderConfig("microsoft");
  if (!cfg || !cfg.enabled) {
    return redirectToLogin(origin, "ms_not_configured");
  }

  const rl = rateLimit(getRateLimitKey(request, "auth.callback"), {
    capacity: 10,
    refillPerSecond: 1,
  });
  if (!rl.allowed) return redirectToLogin(origin, "rate_limited");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = request.cookies.get(MS_STATE_COOKIE)?.value;

  if (!code || !state || !cookieState || state !== cookieState) {
    const res = redirectToLogin(origin, "invalid_state");
    res.cookies.delete(MS_STATE_COOKIE);
    return res;
  }

  let claims: MicrosoftIdClaims;
  let policy: MicrosoftTenantPolicy;
  try {
    const tokens = await exchangeMicrosoftCode({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      tenant: cfg.tenant,
      code,
      redirectUri: microsoftRedirectUri(request),
    });
    if (!tokens.id_token) {
      console.error("[auth:microsoft] token exchange returned no id_token");
      const res = redirectToLogin(origin, "auth_failed");
      res.cookies.delete(MS_STATE_COOKIE);
      return res;
    }
    claims = readMicrosoftIdToken(tokens.id_token, cfg.clientId);
    policy = await resolveMicrosoftTenantPolicy(cfg.tenant);
  } catch (err) {
    console.error(
      "[auth:microsoft] token exchange / id_token check failed:",
      err instanceof Error ? err.message : String(err),
    );
    const res = redirectToLogin(origin, "auth_failed");
    res.cookies.delete(MS_STATE_COOKIE);
    return res;
  }

  const connect = connectIntent(request, "microsoft", state);

  // A configured tenant is enforced here as well as in the authority URL: the
  // token's own `tid` must be that tenant. For a sign-in and a connect alike.
  if (policy.kind === "pinned" && claims.tenantId !== policy.tenantId) {
    console.warn("[auth:microsoft] refused: token tenant is not the configured tenant");
    const res = connect
      ? NextResponse.redirect(connectOutcomeUrl(origin, connect.returnTo, { error: "ms_wrong_tenant" }))
      : redirectToLogin(origin, "ms_wrong_tenant");
    res.cookies.delete(MS_STATE_COOKIE);
    res.cookies.delete(CONNECT_COOKIE);
    return res;
  }

  // Connecting Microsoft to the signed-in account (Profile, Sign-in methods):
  // bind (tid, oid) to that account by the person's own request. No address is
  // consulted, so this is how an account Microsoft can't link by email gets it.
  if (connect) {
    return finishConnect(
      request,
      connect,
      { provider: "microsoft", tenantId: claims.tenantId, objectId: claims.objectId },
      { stateCookie: MS_STATE_COOKIE },
    );
  }

  // The (tid, oid) binding decides. Email links a FIRST sign-in only when it is
  // an address Microsoft vouches for (see verifiedMicrosoftEmails); the
  // directory `mail` attribute never counts on its own. The allowlist
  // (ALLOWED_EMAILS plus the allowed_emails table) applies inside
  // resolveFirstPartyUser. When nothing could count because the deployment
  // isn't set up for it, the person is told an administrator must act.
  const vouched = verifiedMicrosoftEmails(claims);
  const resolved = await resolveFirstPartyUser({
    identity: { provider: "microsoft", tenantId: claims.tenantId, objectId: claims.objectId },
    verifiedEmails: vouched.emails,
    noVerifiedEmail: vouched.setupIncomplete ? "ms_setup_incomplete" : "email_unverified",
    profile: {
      displayName:
        claims.name || (claims.email ?? claims.preferredUsername ?? "").split("@")[0] || "Microsoft user",
    },
  });
  if (!resolved.ok) {
    console.warn(`[auth:microsoft] sign-in refused: ${resolved.reason}`);
    const res = redirectToLogin(origin, resolved.reason);
    res.cookies.delete(MS_STATE_COOKIE);
    return res;
  }
  const user = resolved.user;
  const email = user.email;

  // An org that requires single sign-on refuses this session where the org is
  // opened (lib/auth/org-session-scope); the person's other orgs still open.

  // Consume pending invitations (membership + invite-time work-roles + #general),
  // so an invited user lands in their org instead of the empty /onboarding screen.
  // Keyed on the ACCOUNT's address, which a verified address linked or created,
  // never on whatever the token carries today.
  await consumePendingInvitations(user.id, email);

  const sessionId = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await prisma.session.create({
    // The session counts for system admin only through the bound Microsoft
    // identity (see lib/internal/access).
    data: { id: sessionId, userId: user.id, expiresAt, authMethod: "microsoft" },
  });

  const response = NextResponse.redirect(new URL("/", origin));
  response.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  response.cookies.delete(MS_STATE_COOKIE);
  return response;
}
