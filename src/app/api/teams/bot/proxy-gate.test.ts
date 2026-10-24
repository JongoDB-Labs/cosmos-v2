// COSMOS-202 T1: the proxy lets the Bot Connector reach /api/teams/bot (no
// session, no Origin: its credential is the signed bearer the route checks),
// and only that path: a longer name sharing the prefix is guarded as usual.
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/client", () => ({ prisma: { session: { findUnique: vi.fn(async () => null) } } }));
vi.mock("@/lib/cutover/freeze", () => ({ isMutatingMethod: () => false, isPathOrgFrozen: async () => false }));

import { proxy } from "@/proxy";

const post = (path: string) =>
  new NextRequest(new URL(path, "http://localhost:3000"), { method: "POST", headers: { authorization: "Bearer a.b.c", host: "localhost:3000" } });

describe("proxy: /api/teams/bot", () => {
  it("passes a cross-origin, cookieless POST through to the route", async () => {
    const res = await proxy(post("/api/teams/bot"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not stretch to paths that only share the prefix", async () => {
    for (const path of ["/api/teams/botX", "/api/teams/bots"]) {
      const res = await proxy(post(path));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "csrf_blocked" });
    }
  });
});
