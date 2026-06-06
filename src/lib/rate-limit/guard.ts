import { NextResponse } from "next/server";
import { rateLimit, getRateLimitKey, type RateLimitOptions } from "./bucket";

/**
 * Convenience wrapper for use inside an API route. Returns a 429 Response if
 * the bucket is empty, otherwise returns null so the caller can continue.
 *
 *   const limited = checkRateLimit(request, "google.calendar", user.id, {
 *     capacity: 60, refillPerSecond: 1,
 *   });
 *   if (limited) return limited;
 */
export function checkRateLimit(
  request: Request,
  routeId: string,
  userId: string | undefined,
  opts: RateLimitOptions,
): NextResponse | null {
  const result = rateLimit(getRateLimitKey(request, routeId, userId), opts);
  if (result.allowed) return null;
  return NextResponse.json(
    { error: "rate_limited", retryAfter: result.retryAfter },
    { status: 429, headers: { "Retry-After": String(result.retryAfter) } },
  );
}
