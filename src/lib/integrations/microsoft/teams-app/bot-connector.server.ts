import { getProviderConfig } from "@/lib/auth/provider-config";
import { microsoftLoginOrigin } from "../hosts";

/**
 * COSMOS-202 T2: Cosmos writing to Teams, through the Bot Connector.
 *
 * - Where: only to a conversation Teams told us about in a VERIFIED inbound
 *   activity, and only at a serviceUrl on Microsoft's commercial Bot Connector
 *   host (exact host, or a dot-suffix subdomain of it: never a substring).
 *   Checked when the reference is captured AND again on every send, https
 *   only, never following a redirect. Government clouds (GCC High, DoD) use
 *   other hosts and are out of scope: their serviceUrls are refused.
 * - As whom: the bot's app (the instance's Microsoft sign-in app), with a
 *   client-credentials token for the Bot Framework, cached until shortly
 *   before it expires. Never logged.
 */

/** Microsoft's commercial Bot Connector host. */
export const BOT_CONNECTOR_HOST = "smba.trafficmanager.net";

const TIMEOUT_MS = 15_000;
const EARLY_MS = 5 * 60_000;

export type FetchFn = typeof fetch;
export interface ConnectorDeps {
  fetch?: FetchFn;
  now?: () => number;
}

/** Is `serviceUrl` Microsoft's commercial Bot Connector, over https? */
export function isAllowedServiceUrl(serviceUrl: unknown): serviceUrl is string {
  if (typeof serviceUrl !== "string") return false;
  let u: URL;
  try {
    u = new URL(serviceUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return host === BOT_CONNECTOR_HOST || host.endsWith(`.${BOT_CONNECTOR_HOST}`);
}

export class ConnectorError extends Error {
  constructor(
    public status: number,
    public retryAfterMs: number | null,
    message: string,
  ) {
    super(message);
  }
  /** The bot is gone from that conversation (uninstalled, removed): forget it. */
  get gone() {
    return this.status === 403 || this.status === 404;
  }
  get retryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

const tokens = new Map<string, { token: string; exp: number }>();

/** For tests: forget cached tokens. */
export function _resetBotTokens() {
  tokens.clear();
}

/**
 * A Bot Framework token for our app. Single-tenant bot: issued by the app's
 * own tenant, which is the tenant the org pinned (where Teams sent us from).
 */
async function botToken(tenantId: string, deps: ConnectorDeps): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const hit = tokens.get(tenantId);
  if (hit && hit.exp - EARLY_MS > now) return hit.token;
  const app = await getProviderConfig("microsoft");
  if (!app) throw new ConnectorError(0, null, "bot app not configured");
  const res = await (deps.fetch ?? fetch)(`${microsoftLoginOrigin()}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: app.clientId,
      client_secret: app.clientSecret,
      scope: "https://api.botframework.com/.default",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "error",
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) throw new ConnectorError(res.status || 0, null, "bot token refused");
  tokens.set(tenantId, { token: body.access_token, exp: now + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

export interface ConversationRef {
  tenantId: string;
  serviceUrl: string;
  conversationId: string;
}

/** Post one activity (a card or a short text) to a conversation. Throws ConnectorError. */
export async function sendToConversation(ref: ConversationRef, activity: Record<string, unknown>, deps: ConnectorDeps = {}): Promise<void> {
  // Re-checked here, not only when the reference was stored.
  if (!isAllowedServiceUrl(ref.serviceUrl)) throw new ConnectorError(403, null, "serviceUrl not allowed");
  const token = await botToken(ref.tenantId, deps);
  const base = ref.serviceUrl.endsWith("/") ? ref.serviceUrl : `${ref.serviceUrl}/`;
  const url = `${base}v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: "message", ...activity }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new ConnectorError(0, null, "Bot Connector unreachable");
  }
  if (res.ok) return;
  if (res.status === 401) tokens.delete(ref.tenantId);
  const ra = Number(res.headers.get("retry-after"));
  throw new ConnectorError(res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null, `Bot Connector ${res.status}`);
}
