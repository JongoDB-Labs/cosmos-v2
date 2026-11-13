// @vitest-environment node
/**
 * A request that presents a Cosmos bearer is judged by that bearer alone. The
 * session cookie riding on the same request never stands in for it, in
 * getCurrentUser as in getAuthContext.
 *
 * It matters because the proxy skips its same-origin check for a bearer shaped
 * like an API key (a page on another site can't set one), and it checks only
 * the shape. If a bad bearer fell back to the cookie, a cross-site page could
 * send any key-shaped string and act as whoever's browser it runs in.
 *
 * Real auth against a real database. Only `next/headers` is replaced, by the
 * request's headers, which is what the session functions read in production.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { current } = vi.hoisted(() => ({ current: { headers: new Headers() } }));
vi.mock("next/headers", () => {
  const jar = () =>
    new Map(
      (current.headers.get("cookie") ?? "")
        .split(";")
        .map((c) => c.trim().split("="))
        .filter(([k]) => k)
        .map(([k, ...v]) => [k, v.join("=")] as [string, string]),
    );
  return {
    headers: async () => current.headers,
    cookies: async () => {
      const j = jar();
      return {
        get: (name: string) => (j.has(name) ? { name, value: j.get(name)! } : undefined),
        getAll: () => [...j].map(([name, value]) => ({ name, value })),
        has: (name: string) => j.has(name),
        set: () => undefined,
        delete: () => undefined,
      };
    },
  };
});

import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { POST as createOrg } from "@/app/api/v1/orgs/route";

const stamp = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
let userId = "";
let sessionId = "";

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `bearer-${stamp}@cookie.test`, displayName: "Cookie holder" } })).id;
  // Only an existing member may create an org, so the user belongs to one.
  const home = await prisma.organization.create({ data: { name: "Home", slug: `bearer-${stamp}-home` } });
  await prisma.orgMember.create({ data: { orgId: home.id, userId, role: "OWNER" } });
  sessionId = randomBytes(32).toString("hex");
  await prisma.session.create({ data: { id: sessionId, userId, expiresAt: new Date(Date.now() + 3_600_000) } });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { slug: { startsWith: `bearer-${stamp}` } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
});

const cookie = () => `session=${sessionId}`;
const COSMOS_BEARERS = [
  "Bearer cosmos_000000000000_junk", // shaped like a key, matches none
  "Bearer cosmos_oat_00_x", // an OAuth shape nothing issues
  "Bearer cosmos_", // malformed
];

function withHeaders(h: Record<string, string>) {
  current.headers = new Headers(h);
  return getCurrentUser();
}

describe("getCurrentUser", () => {
  it("reads the session cookie when no Cosmos bearer comes with it (the positive control)", async () => {
    expect((await withHeaders({ cookie: cookie() }))?.id).toBe(userId);
    // A bearer that isn't Cosmos's is no Cosmos credential, so it changes nothing.
    expect((await withHeaders({ cookie: cookie(), authorization: "Bearer some-other-service-token" }))?.id).toBe(userId);
  });

  it("ignores the cookie when a Cosmos bearer comes with it", async () => {
    for (const authorization of COSMOS_BEARERS) {
      expect(await withHeaders({ cookie: cookie(), authorization }), authorization).toBeNull();
    }
  });
});

describe("a route that authenticates with getCurrentUser", () => {
  async function create(h: Record<string, string>, slug: string) {
    current.headers = new Headers(h);
    const res = await createOrg(
      new NextRequest("http://localhost/api/v1/orgs", {
        method: "POST",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ name: "Bearer test", slug }),
      }),
    );
    return { status: res.status, made: await prisma.organization.count({ where: { slug } }) };
  }

  it("refuses a junk key-shaped bearer sent with a cookie, and does nothing", async () => {
    expect(await create({ cookie: cookie(), authorization: COSMOS_BEARERS[0] }, `bearer-${stamp}-x`)).toEqual({ status: 401, made: 0 });
  });

  it("acts for the cookie alone (the positive control)", async () => {
    expect(await create({ cookie: cookie() }, `bearer-${stamp}-ok`)).toEqual({ status: 201, made: 1 });
  });
});
