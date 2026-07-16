import { OAuth2Client } from "google-auth-library";
import type { NextRequest } from "next/server";
import { getProviderConfig } from "@/lib/auth/provider-config";
import { getPublicOrigin } from "@/lib/auth/public-url";

/**
 * Build the Google login OAuth2 client (FR 8a162fe7): resolve the client id +
 * secret from the sealed AuthProviderConfig store first (UI-managed, via
 * /admin/sign-in-providers), falling back to the GOOGLE_CLIENT_ID/SECRET env for
 * deployments that still configure Google at the platform level. The redirect
 * URI is deployment config (GOOGLE_REDIRECT_URI), not a secret. Server-only.
 */
/** Resolve the Google login client id + secret (sealed store first, env
 *  fallback). Exposed so the callback can use the same clientId as the token
 *  audience. */
export async function resolveGoogleLoginCreds(): Promise<{
  clientId?: string;
  clientSecret?: string;
}> {
  const stored = await getProviderConfig("google");
  return {
    clientId: stored?.clientId ?? process.env.GOOGLE_CLIENT_ID,
    clientSecret: stored?.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET,
  };
}

/** The Google login redirect URI, derived from the request's public origin (honoring
 *  the proxy/tunnel forwarded host) so it tracks whatever domain the app is served on
 *  — no static config, mirroring the Microsoft flow (microsoftRedirectUri). The
 *  `GOOGLE_REDIRECT_URI` env stays as an OPTIONAL explicit override. */
export function googleRedirectUri(request: NextRequest): string {
  return `${getPublicOrigin(request)}/api/auth/google/callback`;
}

export async function getGoogleLoginClient(redirectUri?: string): Promise<OAuth2Client> {
  const { clientId, clientSecret } = await resolveGoogleLoginCreds();
  // Prefer the per-request redirect (domain-agnostic); fall back to the env override.
  return new OAuth2Client(clientId, clientSecret, redirectUri ?? process.env.GOOGLE_REDIRECT_URI);
}

/** True when Google login is usable — configured in the sealed store (and
 *  enabled) OR via env. Lets the login page hide the button when unconfigured. */
export async function googleLoginConfigured(): Promise<boolean> {
  const stored = await getProviderConfig("google");
  if (stored) return stored.enabled;
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
