import { NextResponse, type NextRequest } from "next/server";
import * as oidc from "openid-client";
import { prisma } from "@/lib/db/client";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { getIpAddress } from "@/lib/api-helpers";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/auth/client";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import {
  completeSsoLogin,
  describeSsoError,
  extractClaims,
  getOidcConfig,
  SSO_TX_COOKIE,
  type SsoTransaction,
} from "@/lib/auth/sso";
import { setRememberedOrgCookie } from "@/lib/auth/remembered-org";

/**
 * SSO callback. openid-client checks the authorization response (state, and the
 * issuer when the IdP sends one), exchanges the code at the token endpoint with
 * the PKCE verifier and the client secret, and checks the ID token's claims:
 * issuer, audience, expiry, issued-at and nonce. Then we extract claims and hand
 * off to completeSsoLogin (the security core: subject-match, ADMIN cap, gov AAL
 * floor, session mint).
 *
 * It does NOT check the ID token's signature, and fetches no JWKS for it. What
 * authenticates the token is TLS to the token endpoint: it came straight from
 * the IdP over HTTPS, in exchange for our client secret, which OpenID Connect
 * Core 1.0 §3.1.3.7 lets stand in for the signature. SSO_ALLOW_INSECURE_ISSUER=1
 * over plain http removes that: anyone on the network path between Cosmos and
 * the IdP can then hand back an ID token of their own.
 */

type RouteParams = { params: Promise<{ orgSlug: string }> };

function redirectToLogin(origin: string, error: string) {
  const res = NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(error)}`, origin),
  );
  res.cookies.delete(SSO_TX_COOKIE);
  return res;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const origin = getPublicOrigin(request);
  const { orgSlug } = await params;

  const rl = rateLimit(getRateLimitKey(request, "auth.sso.callback"), {
    capacity: 10,
    refillPerSecond: 1,
  });
  if (!rl.allowed) {
    return redirectToLogin(origin, "rate_limited");
  }

  // 1. Recover + validate the transaction cookie (state/nonce/PKCE), bound to org.
  const txRaw = request.cookies.get(SSO_TX_COOKIE)?.value;
  if (!txRaw) {
    return redirectToLogin(origin, "invalid_state");
  }
  let tx: SsoTransaction;
  try {
    tx = JSON.parse(txRaw) as SsoTransaction;
  } catch {
    return redirectToLogin(origin, "invalid_state");
  }
  // The cookie must have been minted for THIS org — defeats cross-org replay.
  if (tx.orgSlug !== orgSlug || !tx.state || !tx.nonce || !tx.codeVerifier) {
    return redirectToLogin(origin, "invalid_state");
  }

  // 2. Resolve the connection (must still be enabled).
  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { idpConnection: true },
  });
  const conn = org?.idpConnection;
  if (!conn || !conn.enabled) {
    return redirectToLogin(origin, "sso_not_configured");
  }

  // 3. openid-client checks state, exchanges the code, and checks the ID token's
  //    iss + aud + exp + iat + nonce (not its signature: see the top of file).
  let claimsRaw: Record<string, unknown>;
  try {
    const config = await getOidcConfig(conn);
    // The current request URL carries the ?code & ?state from the IdP. Rebuild
    // it against the PUBLIC origin so the redirect_uri matches what we sent.
    const currentUrl = new URL(
      `/api/auth/sso/${orgSlug}/callback${new URL(request.url).search}`,
      origin,
    );
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: tx.codeVerifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      idTokenExpected: true,
    });
    const idClaims = tokens.claims();
    if (!idClaims) {
      return redirectToLogin(origin, "auth_failed");
    }
    claimsRaw = idClaims as Record<string, unknown>;
  } catch (err) {
    // M1: never the full error object: openid-client errors carry the token
    // response (the tokens themselves), the callback's parameters (the code) or
    // the IdP's error body. describeSsoError keeps each Error in the cause chain
    // by name, code and message only, so a refused address or a bad token still
    // shows behind openid-client's "something went wrong".
    console.error("[sso] code grant / token validation failed", { orgSlug, error: describeSsoError(err) });
    return redirectToLogin(origin, "auth_failed");
  }

  // 4. Normalize claims via attributeMapping and run the security core.
  const claims = extractClaims(claimsRaw, conn);
  if (!claims.subject) {
    return redirectToLogin(origin, "auth_failed");
  }

  const result = await completeSsoLogin(orgSlug, conn, claims, {
    ipAddress: getIpAddress(request) ?? null,
    userAgent: request.headers.get("user-agent"),
  });

  if (!result.ok) {
    // aal_floor_unmet is the gov-relevant rejection; surface it distinctly.
    const errors: Partial<Record<typeof result.reason, string>> = {
      aal_floor_unmet: "sso_aal_required",
      jit_disabled: "sso_no_account",
      account_exists: "sso_account_exists",
      email_untrusted: "sso_email_untrusted",
      issuer_mismatch: "sso_misconfigured",
    };
    const error = errors[result.reason] ?? "auth_failed";
    if (
      result.reason === "issuer_mismatch" ||
      result.reason === "account_exists" ||
      result.reason === "email_untrusted"
    ) {
      console.warn("[sso] sign-in refused", { orgSlug, reason: result.reason });
    }
    return redirectToLogin(origin, error);
  }

  // 5. Set the session cookie (identical to the Google path) + clear the tx.
  //    Straight to the org: an SSO session opens this org and no other.
  const response = NextResponse.redirect(new URL(`/${encodeURIComponent(orgSlug)}`, origin));
  response.cookies.set(SESSION_COOKIE, result.sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  response.cookies.delete(SSO_TX_COOKIE);
  // Remember this org so /login can pre-render its brand next time.
  setRememberedOrgCookie(response, orgSlug);
  return response;
}
