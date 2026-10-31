import { createHash, randomBytes } from "node:crypto";
import { openSecret, sealSecret } from "@/lib/crypto/vault";
import { microsoftLoginOrigin } from "./hosts";

/**
 * COSMOS-202 (B1): a person connects THEIR OWN Microsoft 365 calendar.
 *
 * Delegated auth-code flow with PKCE, against the org's own tenant only (the
 * org admin pins it when enabling the integration), asking for nothing beyond
 * the calendar: no mail, no files. Requested here, at connect time, never at
 * sign-in, so signing in with Microsoft never grants calendar access.
 */

/** Integration slug and connector-credential provider, one name for both. */
export const MS_CALENDAR = "microsoft-365-calendar";

export const MS_CALENDAR_SCOPES = ["openid", "offline_access", "User.Read", "Calendars.ReadWrite"];

/** Fixed path, registered once as a redirect URI on the Entra app. */
export const MS_CALENDAR_CALLBACK_PATH = "/api/v1/microsoft/calendar/callback";
export const MS_CALENDAR_STATE_COOKIE = "ms_cal_state";
const STATE_TTL_MS = 10 * 60_000;
/** Prefix of the admin-consent round trip's state; the rest is the org slug. */
export const ADMIN_CONSENT_STATE = "admin_consent:";

export interface ConnectState {
  state: string;
  verifier: string;
  orgId: string;
  userId: string;
  exp: number;
}

const b64url = (b: Buffer) => b.toString("base64url");

/**
 * A fresh state + PKCE pair. The cookie value is SEALED (authenticated
 * encryption under the vault key), so it can't be forged or edited, and it
 * binds the round trip to the person and org that started it.
 */
export function newConnectState(orgId: string, userId: string, now = Date.now()) {
  const s: ConnectState = {
    state: b64url(randomBytes(24)),
    verifier: b64url(randomBytes(48)),
    orgId,
    userId,
    exp: now + STATE_TTL_MS,
  };
  const challenge = b64url(createHash("sha256").update(s.verifier).digest());
  return { cookie: sealSecret(JSON.stringify(s)), state: s.state, challenge };
}

/**
 * States already used, by hash, until they would have expired anyway, so a
 * replayed callback (same cookie, same state) is refused even if the browser
 * never cleared the cookie. Per process; the 10-minute expiry bounds it.
 */
const usedStates = new Map<string, number>();
const MAX_USED_STATES = 10_000;

/** The sealed cookie, if it is intact, unexpired, and matches `state`. */
export function openConnectState(cookie: string | undefined, state: string | null, now = Date.now()): ConnectState | null {
  if (!cookie || !state) return null;
  let s: ConnectState;
  try {
    s = JSON.parse(openSecret(cookie)) as ConnectState;
  } catch {
    return null;
  }
  if (s.state !== state || typeof s.exp !== "number" || s.exp < now) return null;
  for (const [h, exp] of usedStates) if (exp < now) usedStates.delete(h);
  const h = createHash("sha256").update(state).digest("base64url");
  if (usedStates.has(h)) return null;
  if (usedStates.size >= MAX_USED_STATES) usedStates.delete(usedStates.keys().next().value as string);
  usedStates.set(h, s.exp);
  return s;
}

export function calendarAuthorizeUrl(o: {
  clientId: string;
  tenantId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    response_type: "code",
    redirect_uri: o.redirectUri,
    response_mode: "query",
    scope: MS_CALENDAR_SCOPES.join(" "),
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${microsoftLoginOrigin()}/${encodeURIComponent(o.tenantId)}/oauth2/v2.0/authorize?${q}`;
}

/** Where a tenant admin grants org-wide consent to the calendar scopes, once. */
export function calendarAdminConsentUrl(o: { clientId: string; tenantId: string; redirectUri: string; orgSlug: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: MS_CALENDAR_SCOPES.filter((s) => !["openid", "offline_access"].includes(s))
      .map((s) => `https://graph.microsoft.com/${s}`)
      .join(" "),
    state: `${ADMIN_CONSENT_STATE}${o.orgSlug}`,
  });
  return `${microsoftLoginOrigin()}/${encodeURIComponent(o.tenantId)}/v2.0/adminconsent?${q}`;
}

export interface IdClaims {
  tid: string;
  oid: string;
  upn: string;
}

/**
 * Claims from the id_token the token endpoint returned to us over TLS with our
 * client secret: the same trust basis as the sign-in flow, which also reads
 * Graph rather than validating a signature. Used to PIN the tenant and to map
 * a Microsoft account to this Cosmos person; never to authenticate anyone.
 */
export function idTokenClaims(idToken: string | undefined): IdClaims | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    const upn = payload.preferred_username || payload.upn || payload.email || "";
    if (typeof payload.tid !== "string" || typeof payload.oid !== "string") return null;
    return { tid: payload.tid, oid: payload.oid, upn: String(upn) };
  } catch {
    return null;
  }
}
