import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { session: { findUnique } } }));
vi.mock("@/lib/cutover/freeze", () => ({ isMutatingMethod: () => false, isPathOrgFrozen: async () => false }));

import { proxy } from "@/proxy";
import { API_BUDGETS } from "../api-budget";

let n = 0;
/** A fresh token per test, so buckets never leak between cases. */
const token = () => `Bearer cosmos_abcdef${(n++).toString(16).padStart(6, "0")}_secret`;
const call = (authorization: string | null, method = "GET") =>
  proxy(new NextRequest("http://localhost:3000/api/v1/orgs", {
    method, headers: authorization ? { authorization, origin: "http://localhost:3000" } : {},
  }));

beforeEach(() => findUnique.mockReset());

describe("per-token API budget, in the proxy", () => {
  it("a bearer request carries the policy and what is left", async () => {
    const res = await call(token());
    expect(res.headers.get("ratelimit-policy")).toBe(`"read";q=${API_BUDGETS.read.perMinute};w=60`);
    expect(res.headers.get("ratelimit")).toMatch(/^"read";r=\d+;t=\d+$/);
  });

  it("writes have their own, smaller budget; past it, a 429 problem with Retry-After", async () => {
    const t = token();
    for (let i = 0; i < API_BUDGETS.write.capacity; i++) expect((await call(t, "POST")).status).not.toBe(429);
    const res = await call(t, "POST");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await res.json()).code).toBe("rate_limited");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    // Reads are a separate bucket, still open.
    expect((await call(t, "GET")).status).not.toBe(429);
  });

  it("one token's spending doesn't touch another's", async () => {
    const spent = token();
    for (let i = 0; i <= API_BUDGETS.write.capacity; i++) await call(spent, "POST");
    expect((await call(spent, "POST")).status).toBe(429);
    expect((await call(token(), "POST")).status).not.toBe(429);
  });

  it("a cookie request is not charged and gets no budget headers", async () => {
    findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000) });
    const res = await proxy(new NextRequest("http://localhost:3000/api/v1/orgs", { headers: { cookie: "session=s" } }));
    expect(res.headers.get("ratelimit-policy")).toBeNull();
  });
});
