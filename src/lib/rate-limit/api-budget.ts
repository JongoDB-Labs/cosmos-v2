import { tokenDigest } from "@/lib/auth/token-digest";
import { rateLimit } from "./bucket";

/**
 * Per-credential budgets for the public API (design §3.5), charged in the
 * proxy for every request that presents a Cosmos bearer. One bucket per token
 * (keyed by a hash of the whole token, so a guessed or stolen prefix can't
 * drain someone else's budget) and per class: reads are cheap and bursty,
 * writes are not.
 *
 * In-memory, like the bucket underneath: right for the single instance Cosmos
 * runs as. A multi-replica deployment needs a shared store (design §7, phase 6).
 *
 * Headers follow the IETF RateLimit draft: `RateLimit-Policy` on every
 * bearer response, `RateLimit` with what is left, `Retry-After` on a 429.
 */
export const API_BUDGETS = {
  // 600 a minute sustained, bursts of up to 120.
  read: { capacity: 120, refillPerSecond: 10, perMinute: 600 },
  // 120 a minute sustained, bursts of up to 30.
  write: { capacity: 30, refillPerSecond: 2, perMinute: 120 },
} as const;

export type BudgetClass = keyof typeof API_BUDGETS;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function budgetClass(method: string): BudgetClass {
  return READ_METHODS.has(method.toUpperCase()) ? "read" : "write";
}

export function tokenFingerprint(authorization: string): string {
  return tokenDigest(authorization.trim()).slice(0, 32);
}

export type BudgetResult =
  | { allowed: true; cls: BudgetClass; remaining: number }
  | { allowed: false; cls: BudgetClass; retryAfter: number };

export function chargeApiBudget(authorization: string, method: string): BudgetResult {
  const cls = budgetClass(method);
  const b = API_BUDGETS[cls];
  const r = rateLimit(`api:${cls}:${tokenFingerprint(authorization)}`, b);
  return r.allowed ? { allowed: true, cls, remaining: r.remaining } : { allowed: false, cls, retryAfter: r.retryAfter };
}

export function budgetHeaders(r: BudgetResult): Record<string, string> {
  const b = API_BUDGETS[r.cls];
  const policy = `"${r.cls}";q=${b.perMinute};w=60`;
  if (!r.allowed) {
    return {
      "RateLimit-Policy": policy,
      RateLimit: `"${r.cls}";r=0;t=${r.retryAfter}`,
      "Retry-After": String(r.retryAfter),
    };
  }
  // Seconds until the bucket is full again.
  const refill = Math.ceil((b.capacity - r.remaining) / b.refillPerSecond);
  return { "RateLimit-Policy": policy, RateLimit: `"${r.cls}";r=${r.remaining};t=${refill}` };
}
