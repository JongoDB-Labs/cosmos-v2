import { NextResponse, type NextRequest } from "next/server";
import * as oidc from "openid-client";
import { prisma } from "@/lib/db/client";
import { getPublicOrigin } from "@/lib/auth/public-url";
import {
  getOidcConfig,
  SSO_TX_COOKIE,
  SSO_TX_MAX_AGE_SECONDS,
} from "@/lib/auth/sso";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";

/**
 * SSO login initiation. Resolves the org's IdpConnection, runs OIDC discovery,
 * and redirects the user-agent to the IdP authorize endpoint with PKCE + state
 * + nonce. The transaction values are stashed in a short-lived, httpOnly,
 * org-bound cookie that the callback validates against.
 */

type RouteParams = { params: Promise<{ orgSlug: string }> };

function redirectToLogin(origin: string, error: string) {
  return NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(error)}`, origin),
  );
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const origin = getPublicOrigin(request);
  const { orgSlug } = await params;

  // Brake brute-forcing the login initiator per IP.
  const rl = rateLimit(getRateLimitKey(request, "auth.sso.login"), {
    capacity: 10,
    refillPerSecond: 1,
  });
  if (!rl.allowed) {
    return redirectToLogin(origin, "rate_limited");
  }

  // Resolve the IdP connection for this org. 404 if absent or disabled.
  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, idpConnection: true },
  });
  const conn = org?.idpConnection;
  if (!org || !conn || !conn.enabled) {
    return redirectToLogin(origin, "sso_not_configured");
  }

  let config: oidc.Configuration;
  try {
    config = await getOidcConfig(conn);
  } catch (err) {
    console.error("[sso] discovery failed", { orgSlug, issuer: conn.issuerUrl }, err);
    return redirectToLogin(origin, "sso_discovery_failed");
  }

  // PKCE + state + nonce — all unique per authorization request.
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();

  const redirectUri = `${origin}/api/auth/sso/${orgSlug}/callback`;
  const scope =
    conn.scopes.length > 0
      ? conn.scopes.join(" ")
      : "openid email profile";

  const authUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
    // If a gov AAL floor is configured, *request* it from the IdP so it can
    // step the user up. completeSsoLogin still independently verifies the
    // asserted acr/amr — requesting is a hint, not a trust boundary.
    ...(conn.requiredAcr ? { acr_values: conn.requiredAcr } : {}),
  });

  const response = NextResponse.redirect(authUrl.href);
  // Bind the transaction to this org so a callback for org A can't replay a
  // cookie minted for org B.
  const tx = JSON.stringify({ orgSlug, state, nonce, codeVerifier });
  response.cookies.set(SSO_TX_COOKIE, tx, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SSO_TX_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
