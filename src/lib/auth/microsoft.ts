import type { NextRequest } from "next/server";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { emailDomain, normalizeDomain } from "@/lib/auth/allowed-domains";

/**
 * Microsoft (Entra ID) OAuth — user-consent sign-in via the multi-tenant
 * `/common` authority (or a specific tenant), so coworkers on a Microsoft 365
 * work account can sign in by consenting individually.
 *
 * Credentials are NOT read from env — they're configured in the /admin Sign-in
 * Providers UI and stored vault-sealed (see lib/auth/provider-config). The
 * route handlers fetch the config and pass clientId/clientSecret/tenant in.
 *
 * Identity: an account is bound to the ID token's tenant id + object id
 * (MicrosoftIdentity), never matched by email after its first sign-in. The
 * `email` claim comes from the directory `mail` attribute, which a tenant admin
 * can set to any address, so it counts only when Microsoft marks its domain as
 * verified (`xms_edov`). Which addresses may link a first sign-in is decided by
 * `verifiedMicrosoftEmails`. A single-tenant deployment should set its tenant,
 * so the callback refuses tokens from every other tenant.
 */
export const MS_STATE_COOKIE = "ms_oauth_state";

const AUTHORITY = "https://login.microsoftonline.com";
// Minimal user-consent scopes: identity + read own profile + refresh token.
const SCOPE = "openid profile email User.Read offline_access";

/** Tenant segment of the authority. Default "common" = any work OR personal
 *  account; a domain ("contoso.com") or directory id locks to one tenant, and
 *  the callback then also checks the token's `tid` against it. */
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

/** The personal-account (MSA) tenant. Anyone can create an account there, so a
 *  deployment pinned to it is NOT a tenant whose addresses we trust. */
export const MSA_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which tenants a sign-in may come from.
 *  - `multi`: `common` / `organizations` (or unset). Any tenant may sign in.
 *  - `pinned`: a directory id, or a domain resolved to one, or `consumers`.
 *    The callback refuses any token whose `tid` differs.
 * Pinning decides who may sign in, not which addresses count: those follow the
 * same rule either way (see verifiedMicrosoftEmails).
 */
export type MicrosoftTenantPolicy = { kind: "multi" } | { kind: "pinned"; tenantId: string };

const tenantIdCache = new Map<string, string>();

/** Test seam: forget resolved domain → tenant id lookups. */
export function clearMicrosoftTenantCache(): void {
  tenantIdCache.clear();
}

/** Resolve a tenant configured as a domain to its directory id through the
 *  tenant's public OpenID metadata, whose issuer names the id. Throws if it
 *  can't, so a misconfigured tenant fails closed. */
async function tenantIdForDomain(domain: string): Promise<string> {
  const key = domain.toLowerCase();
  const cached = tenantIdCache.get(key);
  if (cached) return cached;
  const res = await fetch(
    `${AUTHORITY}/${encodeURIComponent(key)}/v2.0/.well-known/openid-configuration`,
  );
  if (!res.ok) throw new Error(`microsoft tenant discovery failed: ${res.status}`);
  const meta = (await res.json()) as { issuer?: unknown };
  const m =
    typeof meta.issuer === "string"
      ? meta.issuer.match(/^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/i)
      : null;
  if (!m || !GUID.test(m[1])) throw new Error("microsoft tenant discovery returned no tenant id");
  const id = m[1].toLowerCase();
  tenantIdCache.set(key, id);
  return id;
}

export async function resolveMicrosoftTenantPolicy(
  configured?: string | null,
): Promise<MicrosoftTenantPolicy> {
  const t = microsoftTenant(configured).toLowerCase();
  if (t === "common" || t === "organizations") return { kind: "multi" };
  if (t === "consumers") return { kind: "pinned", tenantId: MSA_TENANT_ID };
  const tenantId = GUID.test(t) ? t : await tenantIdForDomain(t);
  return { kind: "pinned", tenantId };
}

/** The ID-token claims sign-in uses. */
export interface MicrosoftIdClaims {
  tenantId: string;
  objectId: string;
  /** The `email` claim. Entra fills it from the tenant-editable `mail`
   *  attribute, so on its own it proves nothing. */
  email: string | null;
  preferredUsername: string | null;
  /** `xms_edov`: Entra's own statement that the email's domain owner is
   *  verified. Null when the token has no such claim: the app registration has
   *  not been set up to send it. */
  emailDomainVerified: boolean | null;
  /** `acct`: 0 for a member of the tenant, 1 for a guest. Null when absent. */
  acct: number | null;
  name: string | null;
}

/**
 * Read the ID token from the token response. The token came straight from
 * Microsoft's token endpoint over TLS, in exchange for our client secret, so
 * OpenID Connect lets TLS stand in for the signature check (Core 1.0
 * §3.1.3.7, step 6). The claims are still checked: audience, expiry, and an
 * issuer that names the same tenant as `tid`.
 */
export function readMicrosoftIdToken(idToken: string, clientId: string): MicrosoftIdClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("microsoft id_token is not a JWT");
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("microsoft id_token payload is unreadable");
  }
  const aud = c.aud;
  if (!(aud === clientId || (Array.isArray(aud) && aud.includes(clientId)))) {
    throw new Error("microsoft id_token audience mismatch");
  }
  const exp = typeof c.exp === "number" ? c.exp : 0;
  if (exp * 1000 < Date.now() - 5 * 60_000) throw new Error("microsoft id_token expired");
  const tid = typeof c.tid === "string" ? c.tid.toLowerCase() : "";
  const oid = typeof c.oid === "string" ? c.oid.toLowerCase() : "";
  if (!GUID.test(tid) || !oid) throw new Error("microsoft id_token missing tid/oid");
  if (typeof c.iss !== "string" || c.iss.toLowerCase() !== `${AUTHORITY}/${tid}/v2.0`) {
    throw new Error("microsoft id_token issuer does not match its tenant");
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    tenantId: tid,
    objectId: oid,
    email: str(c.email)?.toLowerCase() ?? null,
    preferredUsername: str(c.preferred_username)?.toLowerCase() ?? null,
    emailDomainVerified: typeof c.xms_edov === "boolean" ? c.xms_edov : null,
    acct: typeof c.acct === "number" ? c.acct : null,
    name: str(c.name),
  };
}

const looksLikeAddress = (v: string | null): v is string =>
  !!v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && !v.includes("#ext#");

/**
 * Domains whose Microsoft member accounts the operator trusts for their sign-in
 * name (`preferred_username`): `MICROSOFT_TRUSTED_DOMAINS`, comma-separated.
 * Empty by default, so nothing is trusted that way until the operator says so.
 */
export function microsoftTrustedDomains(): string[] {
  return (process.env.MICROSOFT_TRUSTED_DOMAINS ?? "")
    .split(",")
    .map(normalizeDomain)
    .filter(Boolean);
}

/**
 * The addresses this sign-in may use to LINK an existing account, or to create
 * one. Callers must already have refused a token whose tid is not the pinned
 * tenant.
 *  - `email`, only when `xms_edov` is true: Microsoft says the domain's owner is
 *    verified. On its own `email` is the directory `mail` attribute, which any
 *    tenant admin can set to any address, pinned tenant or not.
 *  - `preferred_username` (the sign-in name), only for a member account (not a
 *    guest: `acct` 0 or absent, and no `#EXT#` in the name), not a personal
 *    Microsoft account, and on a domain the operator lists in
 *    MICROSOFT_TRUSTED_DOMAINS. A tenant can only give its members sign-in names
 *    on domains it has verified.
 *  - Graph's `mail`: never.
 * `setupIncomplete` is true when nothing could count because the deployment has
 * not been set up for it (the token carries no `xms_edov`, and no domains are
 * trusted): the person can't fix that, an administrator can.
 */
export function verifiedMicrosoftEmails(
  claims: MicrosoftIdClaims,
  trustedDomains: string[] = microsoftTrustedDomains(),
): { emails: string[]; setupIncomplete: boolean } {
  const out: string[] = [];
  if (claims.emailDomainVerified === true && looksLikeAddress(claims.email)) out.push(claims.email);
  const upn = claims.preferredUsername;
  const member = claims.acct == null || claims.acct === 0;
  if (
    member &&
    claims.tenantId !== MSA_TENANT_ID &&
    looksLikeAddress(upn) &&
    trustedDomains.includes(emailDomain(upn))
  ) {
    out.push(upn);
  }
  const emails = [...new Set(out)];
  const setupIncomplete =
    emails.length === 0 && claims.emailDomainVerified == null && trustedDomains.length === 0;
  return { emails, setupIncomplete };
}
