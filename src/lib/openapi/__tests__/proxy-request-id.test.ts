import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { session: { findUnique } } }));
vi.mock("@/lib/cutover/freeze", () => ({
  isMutatingMethod: () => false,
  isPathOrgFrozen: async () => false,
}));

import { proxy } from "@/proxy";

const req = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(path, "http://localhost:3000"), { headers });

/** What the route handler will see as its request's `x-request-id`. */
const forwardedId = (res: Response) => res.headers.get("x-middleware-request-x-request-id");

beforeEach(() => findUnique.mockReset());

describe("proxy: X-Request-Id", () => {
  it("is on a forwarded response, and the route sees the same id", async () => {
    const res = await proxy(req("/api/health"));
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(forwardedId(res)).toBe(id);
  });

  it("echoes a plain inbound id end to end", async () => {
    findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000) });
    const res = await proxy(req("/api/v1/me", { cookie: "session=s1", "x-request-id": "trace-42" }));
    expect(res.headers.get("x-request-id")).toBe("trace-42");
    expect(forwardedId(res)).toBe("trace-42");
  });

  it("replaces an unsafe inbound id on both sides", async () => {
    const res = await proxy(req("/api/health", { "x-request-id": "<b>hi</b>" }));
    const id = res.headers.get("x-request-id");
    expect(id).not.toBe("<b>hi</b>");
    expect(forwardedId(res)).toBe(id);
  });

  it("is on the proxy's own 401, whose body is a problem with the legacy error", async () => {
    findUnique.mockResolvedValue(null);
    const res = await proxy(req("/api/v1/orgs"));
    expect(res.status).toBe(401);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(body.code).toBe("unauthorized");
  });

  it("is on the login redirect too", async () => {
    const res = await proxy(req("/acme/projects"));
    expect(res.status).toBe(307);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("proxy: Cosmos bearers", () => {
  it("lets any cosmos_ bearer past the session gate on /api, for the route to decide", async () => {
    const res = await proxy(req("/api/v1/orgs", { authorization: "Bearer cosmos_oat_0f_x" }));
    expect(res.status).toBe(200);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("does not treat a non-Cosmos bearer as a credential", async () => {
    const res = await proxy(req("/api/v1/orgs", { authorization: "Bearer ghp_abc" }));
    expect(res.status).toBe(401);
  });
});
