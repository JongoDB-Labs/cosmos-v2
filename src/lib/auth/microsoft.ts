import type { NextRequest } from "next/server";
import { getPublicOrigin } from "@/lib/auth/public-url";

/**
 * Microsoft (Entra ID) OAuth — user-consent sign-in via the multi-tenant
 * `/common` authority, so coworkers on a Microsoft 365 work account can sign in
 * by consenting individually (no work-tenant admin involvement).
 *
 * Runtime-gated: the buttons/routes activate only once MICROSOFT_CLIENT_ID +
 * MICROSOFT_CLIENT_SECRET are set, so shipping this without credentials is inert.
 */
export const MS_STATE_COOKIE = "ms_oauth_state";

const AUTHORITY = "https://login.microsoftonline.com";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me";
// Minimal user-consent scopes: identity + read own profile + refresh token.
const SCOPE = "openid profile email User.Read offline_access";

/** Tenant segment of the authority. Default "common" = any work OR personal
 *  account; override with MICROSOFT_TENANT (e.g. "organizations" or a tenant id). */
export function microsoftTenant(): string {
  return process.env.MICROSOFT_TENANT?.trim() || "common";
}

export function microsoftConfigured(): boolean {
  return Boolean(
    process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET,
  );
}

/** The redirect URI registered in the Entra app. Derived from the public origin
 *  (honoring the nginx/Cloudflare forwarded host) unless explicitly overridden. */
export function microsoftRedirectUri(request: NextRequest): string {
  return (
    process.env.MICROSOFT_REDIRECT_URI?.trim() ||
    `${getPublicOrigin(request)}/api/auth/microsoft/callback`
  );
}

export function microsoftAuthorizeUrl(opts: {
  state: string;
  redirectUri: string;
}): string {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: opts.redirectUri,
    response_mode: "query",
    scope: SCOPE,
    state: opts.state,
    prompt: "select_account",
  });
  return `${AUTHORITY}/${microsoftTenant()}/oauth2/v2.0/authorize?${params.toString()}`;
}

export interface MicrosoftTokens {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
}

export async function exchangeMicrosoftCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<MicrosoftTokens> {
  const body = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
    client_secret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
    scope: SCOPE,
  });
  const res = await fetch(`${AUTHORITY}/${microsoftTenant()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`microsoft token exchange failed: ${res.status}`);
  }
  return (await res.json()) as MicrosoftTokens;
}

export interface MicrosoftProfile {
  id: string;
  email: string;
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
  // Work/school accounts populate `mail`; some only have `userPrincipalName`.
  const email = (me.mail || me.userPrincipalName || "").toLowerCase();
  if (!me.id || !email) {
    throw new Error("microsoft profile missing id/email");
  }
  return {
    id: me.id,
    email,
    displayName: me.displayName || email.split("@")[0],
  };
}
