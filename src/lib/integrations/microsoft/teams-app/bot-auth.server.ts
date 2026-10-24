import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { botFrameworkLoginOrigin } from "../hosts";

/**
 * COSMOS-202 T1: is this request really from the Bot Framework, for our bot?
 *
 * The Bot Connector signs every request it sends a bot with a JWT. Verified as
 * Microsoft documents it (bot-framework-rest-connector-authentication), all of:
 *  - Bearer scheme; RS256 only (the metadata's one algorithm);
 *  - signed by a key in the Bot Framework's published key set, which is
 *    refreshed at least daily and on an unknown key id (rotation), never more
 *    than once every five minutes, so forged key ids can't make us fetch;
 *  - that key endorses the activity's channel ("msteams");
 *  - iss is https://api.botframework.com, aud is our app id;
 *  - inside its validity window, with five minutes' skew;
 *  - its serviceUrl claim equals the activity's serviceUrl.
 * The key set is kept through an outage of the key endpoint, but not past
 * twice its refresh age: after that nothing is accepted until it refreshes.
 * The app id is looked up only once the signature has checked out, so an
 * anonymous request never reaches the database.
 * There is deliberately no switch to turn any of it off.
 */

const ISSUER = "https://api.botframework.com";
const CHANNEL = "msteams";
const SKEW_S = 5 * 60;
const MAX_KEY_AGE_MS = 24 * 3600_000;
const MIN_REFETCH_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export class BotAuthError extends Error {
  constructor(public reason: string) {
    super(`bot auth: ${reason}`);
  }
}

type FetchFn = typeof fetch;
interface Deps {
  fetch?: FetchFn;
  now?: () => number;
}

interface SigningKey {
  key: KeyObject;
  endorsements: string[];
}
let keys: { byKid: Map<string, SigningKey>; at: number } | null = null;
let loading: Promise<void> | null = null;
let lastAttempt = 0;

/** For tests: forget the cached key set. */
export function _resetBotKeys() {
  keys = null;
  loading = null;
  lastAttempt = 0;
}

async function loadKeys(f: FetchFn, now: number) {
  lastAttempt = now;
  const meta = (await (await f(`${botFrameworkLoginOrigin()}/v1/.well-known/openidconfiguration`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })).json()) as { jwks_uri?: unknown };
  // The key set must come from the same login host, whatever the document says.
  const jwksUri = typeof meta.jwks_uri === "string" ? new URL(meta.jwks_uri) : null;
  if (!jwksUri || jwksUri.origin !== new URL(botFrameworkLoginOrigin()).origin) throw new BotAuthError("bad_metadata");
  const set = (await (await f(jwksUri.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })).json()) as {
    keys?: { kid?: string; kty?: string; endorsements?: unknown }[];
  };
  const byKid = new Map<string, SigningKey>();
  for (const jwk of set.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    try {
      byKid.set(jwk.kid, {
        key: createPublicKey({ key: jwk as import("node:crypto").JsonWebKey, format: "jwk" }),
        endorsements: Array.isArray(jwk.endorsements) ? jwk.endorsements.filter((e): e is string => typeof e === "string") : [],
      });
    } catch {
      // A key we can't parse can't sign anything we accept.
    }
  }
  if (!byKid.size) throw new BotAuthError("no_keys");
  keys = { byKid, at: now };
}

async function signingKey(kid: string, deps: Deps): Promise<SigningKey | null> {
  const now = (deps.now ?? Date.now)();
  const stale = !!keys && now - keys.at > MAX_KEY_AGE_MS;
  const unknown = !!keys && !keys.byKid.has(kid);
  if (!keys || ((stale || unknown) && now - lastAttempt > MIN_REFETCH_MS)) {
    loading ??= loadKeys(deps.fetch ?? fetch, now).finally(() => (loading = null));
    try {
      await loading;
    } catch (e) {
      // Keep serving the keys we have through an outage of the key endpoint.
      if (!keys) throw e instanceof BotAuthError ? e : new BotAuthError("keys_unavailable");
    }
  }
  // ...but not for ever: keys we couldn't refresh for two days fail closed.
  if (keys && now - keys.at > 2 * MAX_KEY_AGE_MS) throw new BotAuthError("keys_expired");
  return keys?.byKid.get(kid) ?? null;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;

/**
 * Throws BotAuthError unless `authorization` is a Bot Framework token for
 * our app that covers this activity (its channel and serviceUrl). `appId` is
 * the id, or how to look it up; it is called only after the signature,
 * issuer, validity window and serviceUrl have all checked out. "not_configured"
 * means a genuine token arrived while this instance has no Microsoft app.
 */
export async function verifyBotRequest(
  authorization: string | null,
  activity: { channelId?: unknown; serviceUrl?: unknown },
  appId: string | (() => Promise<string | null>),
  deps: Deps = {},
): Promise<void> {
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!m) throw new BotAuthError("no_token");
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    header = b64json(m[1]);
    claims = b64json(m[2]);
  } catch {
    throw new BotAuthError("malformed");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new BotAuthError("bad_alg");
  if (activity.channelId !== CHANNEL) throw new BotAuthError("bad_channel");

  const key = await signingKey(header.kid, deps);
  if (!key) throw new BotAuthError("unknown_key");
  const signed = verify("RSA-SHA256", Buffer.from(`${m[1]}.${m[2]}`), key.key, Buffer.from(m[3], "base64url"));
  if (!signed) throw new BotAuthError("bad_signature");
  if (!key.endorsements.includes(CHANNEL)) throw new BotAuthError("not_endorsed");

  if (claims.iss !== ISSUER) throw new BotAuthError("bad_issuer");
  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) throw new BotAuthError("expired");
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > now) throw new BotAuthError("not_yet_valid");
  const norm = (u: unknown) => (typeof u === "string" ? u.replace(/\/+$/, "").toLowerCase() : null);
  if (!norm(claims.serviceUrl) || norm(claims.serviceUrl) !== norm(activity.serviceUrl)) throw new BotAuthError("bad_service_url");

  const id = typeof appId === "string" ? appId : await appId();
  if (!id) throw new BotAuthError("not_configured");
  const aud = claims.aud;
  if (!(aud === id || (Array.isArray(aud) && aud.length === 1 && aud[0] === id))) throw new BotAuthError("bad_audience");
}
