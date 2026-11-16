// A password-reset email is opened signed out by definition: the person can't
// sign in, which is why they asked. The proxy must let that visit reach the
// page with its token, rather than send it to a bare /login that drops it.
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/client", () => ({ prisma: { session: { findUnique: vi.fn(async () => null) } } }));
vi.mock("@/lib/cutover/freeze", () => ({ isMutatingMethod: () => false, isPathOrgFrozen: async () => false }));

import { proxy } from "@/proxy";
import { resetPasswordUrl } from "@/lib/auth/reset-link";

const BASE = "http://localhost:3000";
const get = (path: string) => new NextRequest(new URL(path, BASE), { method: "GET", headers: { host: "localhost:3000" } });

// The link exactly as both routes that send it build it.
const link = new URL(resetPasswordUrl(BASE, "abc"));

describe("proxy: the password-reset page", () => {
  it("lets a signed-out visit to the emailed link through, token and all", async () => {
    expect(link.pathname).toBe("/reset-password");
    const res = await proxy(get(`${link.pathname}${link.search}`));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("location")).toBeNull();
  });

  it("opens only the page itself, not paths below it or beside it", async () => {
    for (const path of ["/reset-password/projects", "/reset-passwordX", "/projects"]) {
      const res = await proxy(get(path));
      expect(res.status, path).toBe(307);
      expect(new URL(res.headers.get("location")!, BASE).pathname, path).toBe("/login");
    }
  });

  it("sends no referrer from the page whose URL carries the token", async () => {
    const reset = await proxy(get(`${link.pathname}${link.search}`));
    expect(reset.headers.get("referrer-policy")).toBe("no-referrer");
    // Every other page keeps the site-wide policy.
    const login = await proxy(get("/login"));
    expect(login.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
});
