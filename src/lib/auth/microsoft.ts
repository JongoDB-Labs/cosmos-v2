import type { NextRequest } from "next/server";
import { getPublicOrigin } from "@/lib/auth/public-url";

/**
 * Microsoft (Entra ID) OAuth — user-consent sign-in via the multi-tenant
 * `/common` authority (or a specific tenant), so coworkers on a Microsoft 365
 * work account can sign in by consenting individually.
 *
 * Credentials are NOT read from env — they're configured in the /admin Sign-in
 * Providers UI and stored vault-sealed (see lib/auth/provider-config). The
 * route handlers fetch the config and pass clientId/clientSecret/tenant in.
 */
export const MS_STATE_COOKIE = "ms_oauth_state";

const AUTHORITY = "https://login.microsoftonline.com";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me";
// Minimal user-consent scopes: identity + read own profile + refresh token.
const SCOPE = "openid profile email User.Read offline_access";

/** Tenant segment of the authority. Default "common" = any work OR personal
 *  account; a domain ("contoso.com") or directory id locks to one tenant. */
export function microsoftTenant(configured?: string | null): string {
  return configured?.trim() || "common";
}

/** The redirect URI registered in the Entra app. Derived from the public origin
 *  (honoring the nginx/Cloudflare forwarded host). */
export function microsoftRedirectUri(request: NextRequest): string {
  return `${getPublicOrigin(request)}/api/auth/microsoft/callback`;
}

export function microsoftAuthorizeUrl(opts: {
  clientId: string;
  tenant?: string | null;
  state: string;
  redirectUri: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    response_mode: "query",
    scope: SCOPE,
    state: opts.state,
    prompt: "select_account",
  });
  return `${AUTHORITY}/${microsoftTenant(opts.tenant)}/oauth2/v2.0/authorize?${params.toString()}`;
}

export interface MicrosoftTokens {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
}

export async function exchangeMicrosoftCode(opts: {
  clientId: string;
  clientSecret: string;
  tenant?: string | null;
  code: string;
  redirectUri: string;
}): Promise<MicrosoftTokens> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
    scope: SCOPE,
  });
  const res = await fetch(
    `${AUTHORITY}/${microsoftTenant(opts.tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(`microsoft token exchange failed: ${res.status}`);
  }
  return (await res.json()) as MicrosoftTokens;
}

export interface MicrosoftProfile {
  id: string;
  /** Primary address (mail, else UPN) — used for display + the create path. */
  email: string;
  /** All of the user's own verified addresses (mail + UPN), deduped +
   *  lowercased. Enterprise M365 accounts often have a primary SMTP `mail`
   *  alias that differs from the UPN, so the allowlist is checked against BOTH
   *  rather than only `mail || UPN`. */
  emailCandidates: string[];
  displayName: string;
}

/**
 * Read the verified profile from Microsoft Graph. We trust the Graph response
 * because the access token was obtained directly from the token endpoint over
 * TLS using our client secret — so we avoid the JWKS dance needed to validate a
 * `/common` id_token signature ourselves.
 */
export async function fetchMicrosoftProfile(
  accessToken: string,
): Promise<MicrosoftProfile> {
  const res = await fetch(GRAPH_ME, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`microsoft graph /me failed: ${res.status}`);
  }
  const me = (await res.json()) as {
    id?: string;
    mail?: string | null;
    userPrincipalName?: string | null;
    displayName?: string | null;
  };
  const candidates = [me.mail, me.userPrincipalName]
    .map((v) => (v ?? "").trim().toLowerCase())
    .filter(Boolean);
  const emailCandidates = [...new Set(candidates)];
  const email = emailCandidates[0] ?? "";
  if (!me.id || !email) {
    throw new Error("microsoft profile missing id/email");
  }
  return {
    id: me.id,
    email,
    emailCandidates,
    displayName: me.displayName || email.split("@")[0],
  };
}
