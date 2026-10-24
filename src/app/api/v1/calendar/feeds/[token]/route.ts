import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { renderFeed } from "@/lib/calendar/feed.server";
import { hashFeedToken, parseFeedSegment } from "@/lib/calendar/feed-token";

type RouteParams = { params: Promise<{ token: string }> };

/**
 * GET /api/v1/calendar/feeds/<token>.ics: a person's calendar, for Outlook /
 * Google / Apple Calendar to subscribe to (COSMOS-202). No session: the
 * calendar provider fetches it from its own servers, so the path token IS the
 * credential (see lib/calendar/feed-token). It is exempt from the session gate
 * in proxy.ts, and checks everything itself in renderFeed.
 *
 * Every refusal (bad token, revoked, feeds off, no longer a member, a crash)
 * is the same empty 404, so the response says nothing about which check
 * failed. Nothing here logs the path or the token.
 */

/** Per link: a calendar polls every few hours; this allows bursts and retries. */
const PER_TOKEN = { capacity: 20, refillPerSecond: 1 / 60 };
/** Per IP: generous, because one provider fetches many people's feeds from shared IPs. */
const PER_IP = { capacity: 600, refillPerSecond: 5 };

const notFound = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(request: NextRequest, { params }: RouteParams) {
  const token = parseFeedSegment((await params).token);
  if (!token) return notFound();

  for (const [key, opts] of [
    [`calfeed:${hashFeedToken(token).slice(0, 16)}`, PER_TOKEN],
    [getRateLimitKey(request, "calendar-feed"), PER_IP],
  ] as const) {
    const r = rateLimit(key, opts);
    if (!r.allowed) {
      return new Response(null, { status: 429, headers: { "Retry-After": String(r.retryAfter) } });
    }
  }

  let feed;
  try {
    feed = await renderFeed(token, { origin: getPublicOrigin(request) });
  } catch (err) {
    // The message only: an error's context could carry the request path.
    console.error("calendar feed render failed:", err instanceof Error ? err.message : "unknown error");
    return notFound();
  }
  if (!feed) return notFound();

  const etag = `"${createHash("sha256").update(feed.ics).digest("hex").slice(0, 32)}"`;
  const headers = {
    ETag: etag,
    "Last-Modified": feed.lastModified.toUTCString(),
    "Cache-Control": "private, max-age=0, must-revalidate",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(feed.ics, {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="calendar.ics"',
    },
  });
}
