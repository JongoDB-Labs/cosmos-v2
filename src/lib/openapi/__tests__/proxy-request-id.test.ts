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
  const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("lets a bearer shaped like an API key past the session gate on /api, for the route to decide", async () => {
    const res = await proxy(req("/api/v1/orgs", { authorization: "Bearer cosmos_0123456789ab_secret" }));
    expect(passed(res)).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("refuses any other cosmos_ bearer with 401, before the route and whatever cookie comes with it", async () => {
    findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000) });
    for (const authorization of ["Bearer cosmos_oat_0f_x", "Bearer cosmos_ort_0f_x", "Bearer cosmos_", "Bearer cosmos_nothex_x", "Bearer  cosmos_0123456789ab_"]) {
      for (const cookie of [undefined, "session=s1"]) {
        const res = await proxy(req("/api/v1/orgs", { authorization, ...(cookie && { cookie }) }));
        expect(res.status, `${authorization} ${cookie ?? ""}`).toBe(401);
        expect(passed(res)).toBe(false);
      }
    }
  });

  it("still lets a signed-in browser through with no Authorization header", async () => {
    findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000) });
    expect(passed(await proxy(req("/api/v1/orgs", { cookie: "session=s1" })))).toBe(true);
  });

  it("leaves public routes alone, whatever the bearer", async () => {
    expect(passed(await proxy(req("/api/health", { authorization: "Bearer cosmos_oat_0f_x" })))).toBe(true);
  });

  it("checks the origin of a cross-site write that carries a non-key bearer", async () => {
    const res = await proxy(
      new NextRequest(new URL("/api/v1/orgs", "http://localhost:3000"), {
        method: "POST",
        headers: { authorization: "Bearer cosmos_oat_0f_x", origin: "https://evil.example", cookie: "session=s1" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("does not treat a non-Cosmos bearer as a credential", async () => {
    const res = await proxy(req("/api/v1/orgs", { authorization: "Bearer ghp_abc" }));
    expect(res.status).toBe(401);
  });
});

describe("proxy: what a signed-out caller reaches", () => {
  const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("the sign-in page's two calls: the org's branding and the request-an-account form", async () => {
    expect(passed(await proxy(req("/api/orgs/acme/brand")))).toBe(true);
    const ask = await proxy(
      new NextRequest(new URL("/api/auth/account-request", "http://localhost:3000"), {
        method: "POST",
        headers: { host: "localhost:3000", origin: "http://localhost:3000" },
      }),
    );
    expect(passed(ask)).toBe(true);
  });

  it("nothing else under /api/orgs", async () => {
    expect((await proxy(req("/api/orgs/acme/brand/extra"))).status).toBe(401);
    expect((await proxy(req("/api/orgs/acme"))).status).toBe(401);
  });

  it("no API path just because it ends like a static file", async () => {
    for (const path of ["/api/v1/orgs/x/documents/abc.js", "/api/v1/orgs/x/files/a.png", "/api/v1/me/avatar.svg"]) {
      expect((await proxy(req(path))).status, path).toBe(401);
    }
    // Real static files outside /api still load without a session (the sign-in page's images).
    expect(passed(await proxy(req("/brand/logo.png")))).toBe(true);
  });
});

