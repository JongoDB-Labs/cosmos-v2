// A password-reset email is opened signed out by definition: the person can't
// sign in, which is why they asked. The proxy must let that visit reach the
// page with its token, rather than send it to a bare /login that drops it.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/client", () => ({ prisma: { session: { findUnique: vi.fn(async () => null) } } }));
vi.mock("@/lib/cutover/freeze", () => ({ isMutatingMethod: () => false, isPathOrgFrozen: async () => false }));

import { proxy } from "@/proxy";

const BASE = "http://localhost:3000";
const get = (path: string) => new NextRequest(new URL(path, BASE), { method: "GET", headers: { host: "localhost:3000" } });

// The page the reset email links to, read from the route that writes the link,
// so the two can't drift apart.
const linkPath = (() => {
  const src = readFileSync(join(process.cwd(), "src/app/api/auth/password/reset/request/route.ts"), "utf8");
  const m = src.match(/getPublicOrigin\(request\)\}(\/[a-z-]+)\?token=/);
  if (!m) throw new Error("the reset request route no longer builds its link the way this test reads it");
  return m[1];
})();

describe("proxy: the password-reset page", () => {
  it("lets a signed-out visit to the emailed link through, token and all", async () => {
    expect(linkPath).toBe("/reset-password");
    const res = await proxy(get(`${linkPath}?token=abc`));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("location")).toBeNull();
  });

  it("still sends a signed-out visit to any other page to sign in", async () => {
    for (const path of ["/reset-passwordX", "/projects"]) {
      const res = await proxy(get(path));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!, BASE).pathname).toBe("/login");
    }
  });
});
