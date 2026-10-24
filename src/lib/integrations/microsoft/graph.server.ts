import { microsoftGraphOrigin } from "./hosts";
import { calendarAccessToken, _forgetCalendarAccessToken } from "./calendar-token.server";

/**
 * Microsoft Graph, as one connected person (COSMOS-202 B2).
 *
 * - Throttling: a 429 or 503 is retried after the Retry-After Microsoft gives
 *   (capped), at most twice; then it surfaces as GraphThrottled, so a sync run
 *   stops for that person instead of hammering.
 * - A 401 means our cached access token went stale early (revoked session,
 *   clock skew): forget it and retry once with a fresh one.
 * - Every call has a timeout. Nothing here logs a token or a response body.
 */

export class GraphError extends Error {
  constructor(public status: number, public code: string) {
    super(`graph ${status} ${code}`);
  }
}
export class GraphThrottled extends GraphError {}

type FetchFn = typeof fetch;
export interface GraphDeps {
  fetch?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Acting for a connection that is being removed (see onCalendarOffboard). */
  offboarding?: boolean;
}

const TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_THROTTLE_RETRIES = 2;

/** Seconds (or an HTTP date) from Retry-After, in ms, capped; 2s if absent. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 2_000;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - now;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

export async function graphRequest<T = unknown>(
  orgId: string,
  userId: string,
  method: string,
  pathOrUrl: string,
  body?: unknown,
  deps: GraphDeps = {},
): Promise<{ status: number; data: T }> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  // Delta and paging links come back absolute; only follow ones on the Graph host.
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${microsoftGraphOrigin()}/v1.0${pathOrUrl}`;
  if (!url.startsWith(microsoftGraphOrigin() + "/")) throw new GraphError(0, "foreign_link");

  let throttled = 0;
  let reauthed = false;
  for (;;) {
    const token = await calendarAccessToken(orgId, userId, { fetch: deps.fetch, now: deps.now, offboarding: deps.offboarding });
    const res = await f(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        // Times as UTC, so they round-trip without a zone database.
        Prefer: 'outlook.timezone="UTC"',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && !reauthed) {
      reauthed = true;
      _forgetCalendarAccessToken(orgId, userId);
      continue;
    }
    if ((res.status === 429 || res.status === 503) && throttled < MAX_THROTTLE_RETRIES) {
      throttled++;
      await sleep(retryAfterMs(res.headers.get("retry-after"), (deps.now ?? Date.now)()));
      continue;
    }
    const text = await res.text();
    const data = (text ? JSON.parse(text) : null) as T & { error?: { code?: string } };
    if (res.status === 429 || res.status === 503) throw new GraphThrottled(res.status, "throttled");
    if (!res.ok) throw new GraphError(res.status, data?.error?.code ?? "error");
    return { status: res.status, data };
  }
}
