import { slackOrigin } from "./config";

/**
 * Calling the Slack Web API. Slack answers most failures with HTTP 200 and
 * `{ ok: false, error: "<code>" }`, and a rate limit with 429 and Retry-After;
 * every one of them becomes a SlackApiError carrying the code, which is all
 * that is ever logged or stored. Never the token, never a response body.
 */

const TIMEOUT_MS = 15_000;

export type FetchFn = typeof fetch;
export interface SlackDeps {
  fetch?: FetchFn;
}

/** The token no longer works: the app was removed or the token revoked. */
const TOKEN_DEAD = new Set([
  "invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive",
  "team_access_not_granted", "org_login_required", "ekm_access_denied",
]);
/** Slack can't reach this person any more. */
const RECIPIENT_GONE = new Set(["user_not_found", "users_not_found", "user_disabled", "cannot_dm_bot", "user_not_visible"]);
/** Worth trying again later. */
const TRANSIENT = new Set(["ratelimited", "service_unavailable", "internal_error", "fatal_error", "request_timeout", "timeout"]);

export class SlackApiError extends Error {
  constructor(
    /** Slack's error code, "http_<status>", "network" or "bad_response". */
    public code: string,
    public status: number,
    public retryAfterMs: number | null = null,
  ) {
    super(`slack: ${code}`);
  }
  get retryable() {
    return this.status === 429 || this.status >= 500 || this.code === "network" || TRANSIENT.has(this.code);
  }
  get tokenDead() {
    return TOKEN_DEAD.has(this.code);
  }
  get recipientGone() {
    return RECIPIENT_GONE.has(this.code);
  }
}

type Params = Record<string, string | boolean | number | undefined>;

function form(params: Params): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
}

/**
 * POST a Web API method, form-encoded. `auth` is the bot token (Bearer), or
 * the app's client id and secret (Basic) for the OAuth methods. Redirects are
 * refused, so a credential never follows one anywhere.
 */
export async function slackApi<T extends Record<string, unknown>>(
  method: string,
  auth: { bearer: string } | { basic: { user: string; password: string } },
  params: Params,
  deps: SlackDeps = {},
): Promise<T> {
  const f = deps.fetch ?? fetch;
  const authorization =
    "bearer" in auth
      ? `Bearer ${auth.bearer}`
      : `Basic ${Buffer.from(`${encodeURIComponent(auth.basic.user)}:${encodeURIComponent(auth.basic.password)}`).toString("base64")}`;
  let res: Response;
  try {
    res = await f(`${slackOrigin()}/api/${method}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: form(params),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SlackApiError("network", 0);
  }
  if (res.status === 429) {
    const s = Number(res.headers.get("retry-after"));
    throw new SlackApiError("ratelimited", 429, Number.isFinite(s) && s > 0 ? s * 1000 : null);
  }
  if (!res.ok) throw new SlackApiError(`http_${res.status}`, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SlackApiError("bad_response", res.status);
  }
  if (typeof body !== "object" || body === null) throw new SlackApiError("bad_response", res.status);
  const b = body as { ok?: unknown; error?: unknown };
  if (b.ok !== true) {
    const code = typeof b.error === "string" && /^[a-z0-9_.]{1,64}$/.test(b.error) ? b.error : "unknown_error";
    throw new SlackApiError(code, res.status);
  }
  return body as T;
}

/** A Slack user, as users.lookupByEmail returns them (the fields used here). */
export interface SlackUser {
  id: string;
  team_id?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_email_confirmed?: boolean;
  profile?: { email?: string };
}

export async function lookupByEmail(token: string, email: string, deps?: SlackDeps): Promise<SlackUser> {
  const r = await slackApi<{ user?: SlackUser }>("users.lookupByEmail", { bearer: token }, { email }, deps);
  if (!r.user || typeof r.user.id !== "string") throw new SlackApiError("bad_response", 200);
  return r.user;
}

/** The direct message between the bot and `slackUserId`, opened if needed. */
export async function openDirectMessage(token: string, slackUserId: string, deps?: SlackDeps): Promise<string> {
  const r = await slackApi<{ channel?: { id?: unknown } }>("conversations.open", { bearer: token }, { users: slackUserId }, deps);
  if (typeof r.channel?.id !== "string") throw new SlackApiError("bad_response", 200);
  return r.channel.id;
}

export async function postMessage(
  token: string,
  msg: { channel: string; text: string; blocks: unknown[] },
  deps?: SlackDeps,
): Promise<void> {
  await slackApi(
    "chat.postMessage",
    { bearer: token },
    // No unfurling: Slack would otherwise fetch the Cosmos link itself.
    { channel: msg.channel, text: msg.text, blocks: JSON.stringify(msg.blocks), unfurl_links: false, unfurl_media: false },
    deps,
  );
}
