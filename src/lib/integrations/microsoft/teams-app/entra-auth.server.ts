import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { microsoftLoginOrigin } from "../hosts";
import { TEAMS_CLIENT_IDS } from "./teams-clients";

/**
 * COSMOS-202 T1 d: is this a Teams single sign-on token for our tab?
 *
 * The tab asks Teams (TeamsJS getAuthToken) for an access token to our app's
 * "Expose an API" scope, then hands it to us once to start a tab session.
 * Verified in full:
 *  - RS256, signed by a key in the tenant's published key set, found through
 *    the tenant's own OpenID metadata on the Microsoft login host (the key set
 *    must be on that host too). Cached, refreshed at least daily and on an
 *    unknown key id at most every five minutes, and not trusted past 48 hours
 *    without a refresh;
 *  - tid is the org's configured tenant, and iss is that tenant's (v1 or v2);
 *  - aud is our App ID URI, api://{host}/{appId};
 *  - scp includes access_as_user;
 *  - the client (azp in v2, appid in v1) is Microsoft Teams;
 *  - inside its validity window, with five minutes' skew;
 *  - oid present (the caller maps it to a Cosmos user).
 * There is no switch to turn any of it off.
 */

export const TAB_SCOPE = "access_as_user";

const SKEW_S = 5 * 60;
const MAX_KEY_AGE_MS = 24 * 3600_000;
const MIN_REFETCH_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export class EntraAuthError extends Error {
  constructor(public reason: string) {
    super(`entra auth: ${reason}`);
  }
}

type FetchFn = typeof fetch;
interface Deps {
  fetch?: FetchFn;
  now?: () => number;
}

interface TenantKeys {
  byKid: Map<string, KeyObject>;
  at: number;
  issuerV2: string;
}
const cache = new Map<string, TenantKeys>();
const loading = new Map<string, Promise<void>>();
const lastAttempt = new Map<string, number>();

/** For tests: forget cached key sets. */
export function _resetEntraKeys() {
  cache.clear();
  loading.clear();
  lastAttempt.clear();
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function load(tid: string, f: FetchFn, now: number) {
  lastAttempt.set(tid, now);
  const login = microsoftLoginOrigin();
  const meta = (await (await f(`${login}/${tid}/v2.0/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "error",
  })).json()) as { jwks_uri?: unknown; issuer?: unknown };
  const jwksUri = typeof meta.jwks_uri === "string" ? new URL(meta.jwks_uri) : null;
  if (!jwksUri || jwksUri.origin !== new URL(login).origin) throw new EntraAuthError("bad_metadata");
  if (typeof meta.issuer !== "string") throw new EntraAuthError("bad_metadata");
  const set = (await (await f(jwksUri.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" })).json()) as {
    keys?: { kid?: string; kty?: string }[];
  };
  const byKid = new Map<string, KeyObject>();
  for (const jwk of set.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    try {
      byKid.set(jwk.kid, createPublicKey({ key: jwk as import("node:crypto").JsonWebKey, format: "jwk" }));
    } catch {
      // Unparseable: can't have signed anything we accept.
    }
  }
  if (!byKid.size) throw new EntraAuthError("no_keys");
  cache.set(tid, { byKid, at: now, issuerV2: meta.issuer.replace("{tenantid}", tid) });
}

async function tenantKey(tid: string, kid: string, deps: Deps): Promise<{ key: KeyObject | null; issuerV2: string }> {
  const now = (deps.now ?? Date.now)();
  let keys = cache.get(tid);
  const stale = !!keys && now - keys.at > MAX_KEY_AGE_MS;
  const unknown = !!keys && !keys.byKid.has(kid);
  if (!keys || ((stale || unknown) && now - (lastAttempt.get(tid) ?? 0) > MIN_REFETCH_MS)) {
    let p = loading.get(tid);
    if (!p) {
      p = load(tid, deps.fetch ?? fetch, now).finally(() => loading.delete(tid));
      loading.set(tid, p);
    }
    try {
      await p;
    } catch (e) {
      if (!cache.get(tid)) throw e instanceof EntraAuthError ? e : new EntraAuthError("keys_unavailable");
    }
    keys = cache.get(tid);
  }
  if (!keys || now - keys.at > 2 * MAX_KEY_AGE_MS) throw new EntraAuthError("keys_expired");
  return { key: keys.byKid.get(kid) ?? null, issuerV2: keys.issuerV2 };
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;

export interface TabIdentity {
  tid: string;
  oid: string;
}

/**
 * Verify `token` as a Teams SSO token for our tab, in the org's tenant
 * `tenantId`, for our App ID URI. `appIdUri` is the URI or how to work it out:
 * called only after the signature, issuer, scope and validity window check
 * out ("not_configured" when there is none). Returns the person's tid and
 * oid; throws EntraAuthError otherwise.
 */
export async function verifyTabToken(
  token: string,
  tenantId: string,
  appIdUri: string | (() => Promise<string | null>),
  deps: Deps = {},
): Promise<TabIdentity> {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token ?? "");
  if (!m) throw new EntraAuthError("malformed");
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    header = b64json(m[1]);
    claims = b64json(m[2]);
  } catch {
    throw new EntraAuthError("malformed");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new EntraAuthError("bad_alg");
  const tid = tenantId.trim().toLowerCase();
  // The tenant is ours to choose (the org's), never the token's: a token from
  // any other tenant is refused before we fetch anything for it.
  if (!GUID.test(tid) || typeof claims.tid !== "string" || claims.tid.toLowerCase() !== tid) throw new EntraAuthError("wrong_tenant");

  const { key, issuerV2 } = await tenantKey(tid, header.kid, deps);
  if (!key) throw new EntraAuthError("unknown_key");
  if (!verify("RSA-SHA256", Buffer.from(`${m[1]}.${m[2]}`), key, Buffer.from(m[3], "base64url"))) throw new EntraAuthError("bad_signature");

  const issuers = [issuerV2, `https://sts.windows.net/${tid}/`];
  if (typeof claims.iss !== "string" || !issuers.includes(claims.iss)) throw new EntraAuthError("bad_issuer");
  const scopes = typeof claims.scp === "string" ? claims.scp.split(" ") : [];
  if (!scopes.includes(TAB_SCOPE)) throw new EntraAuthError("bad_scope");
  const client = claims.azp ?? claims.appid;
  // Only Microsoft Teams may be the client a tab token was issued to: any other
  // app a user consents to in the same tenant could otherwise mint a token for
  // us and trade it for a tab session.
  if (!(TEAMS_CLIENT_IDS as readonly unknown[]).includes(client)) throw new EntraAuthError("not_teams_client");
  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) throw new EntraAuthError("expired");
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > now) throw new EntraAuthError("not_yet_valid");
  if (typeof claims.oid !== "string" || !claims.oid) throw new EntraAuthError("no_oid");
  const uri = typeof appIdUri === "string" ? appIdUri : await appIdUri();
  if (!uri) throw new EntraAuthError("not_configured");
  if (claims.aud !== uri) throw new EntraAuthError("bad_audience");
  return { tid, oid: claims.oid };
}

/** Our App ID URI: what an admin sets under "Expose an API". */
export function tabAppIdUri(origin: string, appId: string): string {
  return `api://${new URL(origin).host}/${appId}`;
}
