// @vitest-environment node
//
// A calendar feed link is a bearer credential, like an API key, so where an org
// requires single sign-on it is held to the rule a member's key is: it works
// only if it was made from a session of that org's IdP. Through the real route
// and the real getAuthContext, against a real database; only `next/headers` is
// stood in for. Own users and orgs throughout (the seeded users are shared).
import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { patchOrgSettings } from "@/lib/org/patch-settings.server";
import { renderFeed } from "@/lib/calendar/feed.server";
import { parseFeedSegment } from "@/lib/calendar/feed-token";

// The request the route is answering. Each test signs someone in first.
const h = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => h.headers,
  cookies: async () => ({
    get: (name: string) => {
      const m = (h.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
      return m ? { name, value: m[1] } : undefined;
    },
  }),
}));
// getAuthContext and getCurrentUser are wrapped in React's per-request `cache`;
// every call here is its own request.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));

import { POST as createFeed } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = "https://example.com";
const orgIds: string[] = [];
const userIds: string[] = [];
let n = 0;

afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

/** An org with feeds on and an IdP connection, required for sign-in or not. */
async function org(requireSso: boolean) {
  const o = await prisma.organization.create({
    data: { name: `cfs ${stamp} ${++n}`, slug: `cfs-${stamp}-${n}` },
    select: { id: true, tenantClass: true },
  });
  orgIds.push(o.id);
  // Single sign-on can only be required of a GOV-class org (sso-enforcement).
  expect(o.tenantClass).toBe("GOV");
  await patchOrgSettings(o.id, { merge: { key: "calendarFeeds", fields: { enabled: true } } });
  const conn = await prisma.idpConnection.create({
    data: {
      orgId: o.id, issuerUrl: "https://idp.example.test", clientId: "c", clientSecretEnc: "not-opened-by-these-tests",
      enabled: true, enforced: requireSso,
    },
  });
  return { id: o.id, connId: conn.id };
}

/** A member of `orgId`, signed in with a session of this kind. */
async function signIn(orgId: string, session: { authMethod: string; idpConnId?: string }) {
  const email = `cfs-${stamp}-${++n}@feeds.test`;
  const user = await prisma.user.create({ data: { email, displayName: `Feed person ${n}` } });
  userIds.push(user.id);
  await prisma.orgMember.create({ data: { orgId, userId: user.id, role: "MEMBER" } });
  const id = randomBytes(24).toString("hex");
  await prisma.session.create({ data: { id, userId: user.id, expiresAt: new Date(Date.now() + DAY), ...session } });
  h.headers = new Headers({ cookie: `session=${id}` });
  return { userId: user.id, email };
}

const create = (orgId: string) =>
  createFeed(new NextRequest("http://localhost/x", { method: "POST", headers: h.headers, body: "{}" }), {
    params: Promise.resolve({ orgId }),
  });

/** The token in a created link's URL. */
async function tokenOf(res: Response): Promise<string> {
  const { url } = (await res.json()) as { url: string };
  const token = parseFeedSegment(url.split("/").pop() ?? "");
  expect(token).not.toBeNull();
  return token!;
}

describe("calendar feed links and single sign-on (e2e DB)", () => {
  it("records the IdP a link was made through, so it works where the org requires single sign-on", async () => {
    const gov = await org(true);
    const me = await signIn(gov.id, { authMethod: "oidc", idpConnId: gov.connId });
    const res = await create(gov.id);
    expect(res.status).toBe(201);
    const token = await tokenOf(res);
    const row = await prisma.calendarFeed.findFirstOrThrow({ where: { orgId: gov.id, userId: me.userId }, select: { idpConnId: true } });
    expect(row.idpConnId).toBe(gov.connId);
    expect(await renderFeed(token, { origin: ORIGIN })).not.toBeNull();
  });

  it("records none for a session that wasn't single sign-on: it works until the org requires it", async () => {
    const o = await org(false);
    const me = await signIn(o.id, { authMethod: "password" });
    const res = await create(o.id);
    expect(res.status).toBe(201);
    const token = await tokenOf(res);
    const row = await prisma.calendarFeed.findFirstOrThrow({ where: { orgId: o.id, userId: me.userId }, select: { idpConnId: true } });
    expect(row.idpConnId).toBeNull();
    expect(await renderFeed(token, { origin: ORIGIN })).not.toBeNull();

    // Fails closed: once sign-in through the IdP is required, a link with no
    // sign-in behind it stops, until its owner makes a new one through the IdP.
    await prisma.idpConnection.update({ where: { id: o.connId }, data: { enforced: true } });
    expect(await renderFeed(token, { origin: ORIGIN })).toBeNull();
    await prisma.idpConnection.update({ where: { id: o.connId }, data: { enforced: false } });
    expect(await renderFeed(token, { origin: ORIGIN })).not.toBeNull();
  });

  it("won't make a link that single sign-on would then refuse (a platform admin's break-glass session)", async () => {
    const gov = await org(true);
    const admin = await signIn(gov.id, { authMethod: "password" });
    // The premise: a session outside the IdP can't open this org at all...
    expect((await create(gov.id)).status).toBe(401);
    // ...except a platform admin's own, the break-glass. It opens the org, but a
    // link it made would never be served, so none is made.
    vi.stubEnv("INTERNAL_ADMINS", admin.email);
    const res = await create(gov.id);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/single sign-on/);
    expect(await prisma.calendarFeed.count({ where: { orgId: gov.id } })).toBe(0);
  });
});
