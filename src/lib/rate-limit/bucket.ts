/**
 * In-memory token-bucket rate limiter. Keyed by an arbitrary string (usually
 * `${ip}|${routeId}`); each key gets its own bucket that refills at a steady
 * rate. Sufficient for single-instance deployments and as a coarse brake on
 * brute-force / quota-burning. Replace with a Redis bucket if we scale out.
 *
 * Returns `{ allowed: false, retryAfter }` so the caller can emit a 429 with
 * the right `Retry-After` header.
 */
type Bucket = {
  tokens: number;
  lastRefill: number;
};

const BUCKETS: Map<string, Bucket> = new Map();

// Periodically prune buckets that have been full for a while to bound memory.
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
let lastPrune = Date.now();

function prune(now: number, capacity: number) {
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  for (const [k, b] of BUCKETS) {
    if (b.tokens >= capacity && now - b.lastRefill > PRUNE_INTERVAL_MS) {
      BUCKETS.delete(k);
    }
  }
}

export type RateLimitOptions = {
  /** Maximum bursts allowed in a window. */
  capacity: number;
  /** Tokens added per second of elapsed time. */
  refillPerSecond: number;
};

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfter: number };

export function rateLimit(
  key: string,
  opts: RateLimitOptions,
): RateLimitResult {
  const now = Date.now();
  prune(now, opts.capacity);

  const existing = BUCKETS.get(key);
  const bucket: Bucket = existing ?? {
    tokens: opts.capacity,
    lastRefill: now,
  };

  // Refill based on elapsed time, capped at capacity.
  const elapsedSec = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(
    opts.capacity,
    bucket.tokens + elapsedSec * opts.refillPerSecond,
  );
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    BUCKETS.set(key, bucket);
    // Seconds until we accrue one full token.
    const retryAfter = Math.ceil((1 - bucket.tokens) / opts.refillPerSecond);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }

  bucket.tokens -= 1;
  BUCKETS.set(key, bucket);
  return { allowed: true, remaining: Math.floor(bucket.tokens) };
}

/**
 * Pull a stable IP from forwarded headers. Falls back to a placeholder so the
 * bucket still rate-limits unidentified callers as a group rather than letting
 * them slip past.
 */
export function getRateLimitKey(
  request: Request,
  routeId: string,
  userId?: string,
): string {
  if (userId) return `u:${userId}|${routeId}`;
  const fwd =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip");
  const ip = fwd ?? "anon";
  return `ip:${ip}|${routeId}`;
}
