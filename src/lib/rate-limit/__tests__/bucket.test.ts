import { describe, it, expect } from "vitest";
import { rateLimit } from "../bucket";

describe("rateLimit", () => {
  it("allows requests up to the bucket capacity", () => {
    const key = `cap-test-${Math.random()}`;
    const opts = { capacity: 3, refillPerSecond: 0 };
    expect(rateLimit(key, opts).allowed).toBe(true);
    expect(rateLimit(key, opts).allowed).toBe(true);
    expect(rateLimit(key, opts).allowed).toBe(true);
    expect(rateLimit(key, opts).allowed).toBe(false);
  });

  it("isolates buckets per key", () => {
    const a = `iso-a-${Math.random()}`;
    const b = `iso-b-${Math.random()}`;
    const opts = { capacity: 1, refillPerSecond: 0 };
    expect(rateLimit(a, opts).allowed).toBe(true);
    expect(rateLimit(b, opts).allowed).toBe(true);
    expect(rateLimit(a, opts).allowed).toBe(false);
    expect(rateLimit(b, opts).allowed).toBe(false);
  });

  it("returns retryAfter when denied", () => {
    const key = `ra-test-${Math.random()}`;
    const opts = { capacity: 1, refillPerSecond: 0.1 };
    rateLimit(key, opts);
    const res = rateLimit(key, opts);
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.retryAfter).toBeGreaterThanOrEqual(1);
    }
  });
});
