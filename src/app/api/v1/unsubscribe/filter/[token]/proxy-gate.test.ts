// The proxy lets a signed-out reader open a filter email's unsubscribe link
// (the path token is the credential the route checks), still guards its POST
// against other origins, and doesn't stretch to paths sharing the prefix.
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/client", () => ({ prisma: { session: { findUnique: vi.fn(async () => null) } } }));
vi.mock("@/lib/cutover/freeze", () => ({ isMutatingMethod: () => false, isPathOrgFrozen: async () => false }));

import { proxy } from "@/proxy";

const BASE = "http://localhost:3000";
const req = (method: string, path: string, origin?: string) =>
  new NextRequest(new URL(path, BASE), { method, headers: { host: "localhost:3000", ...(origin ? { origin } : {}) } });

describe("proxy: /api/v1/unsubscribe/filter", () => {
  it("passes a signed-out GET, and a same-origin POST, through to the route", async () => {
    for (const r of [req("GET", "/api/v1/unsubscribe/filter/tok"), req("POST", "/api/v1/unsubscribe/filter/tok", BASE)]) {
      const res = await proxy(r);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("refuses a cross-origin POST", async () => {
    const res = await proxy(req("POST", "/api/v1/unsubscribe/filter/tok", "https://elsewhere.example"));
    expect(res.status).toBe(403);
  });

  it("does not stretch to paths that only share the prefix", async () => {
    const res = await proxy(req("GET", "/api/v1/unsubscribe/filterX/tok"));
    expect(res.status).toBe(401);
  });
});
