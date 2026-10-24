// COSMOS-202 T1 d (e2e DB): the Teams tab's own session. A sealed cookie, an
// hour at most, valid only while the person it names is still who they were:
// member, active, still connected. (That only a GET under /teams/tab ever
// reads it is the proxy's and the cookie Path's job: tab-proxy.test.ts.)
import crypto from "node:crypto";
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { sealSecret } from "@/lib/crypto/vault";
import { MS_CALENDAR } from "../calendar-connect";
import { MS_TEAMS_APP } from "./identity.server";
import { TAB_TTL_S, readTabSession, sealTabSession, tabCookieHeader } from "./tab-session.server";

const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;
beforeAll(() => {
  process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");
});
afterAll(() => {
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

describe("Teams tab session (e2e DB)", () => {
  const orgIds: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  });

  async function setup() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tid = crypto.randomUUID();
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({ data: { name: `tab ${stamp}`, slug: `tab-${stamp}` } });
    orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: alice.id, role: "MEMBER" } });
    await prisma.integration.create({ data: { orgId: org.id, provider: MS_CALENDAR, displayName: "Outlook", config: { tenantId: tid }, status: "ACTIVE", installedById: alice.id } });
    const app = await prisma.integration.create({ data: { orgId: org.id, provider: MS_TEAMS_APP, displayName: "Teams", config: {}, status: "ACTIVE", installedById: alice.id } });
    const oid = `oid-${stamp}`;
    await prisma.connectorCredential.create({ data: { orgId: org.id, provider: MS_CALENDAR, userId: alice.id, secretEnc: "sealed", meta: { tid, oid, status: "connected" } } });
    const cookie = sealTabSession({ orgId: org.id, userId: alice.id, tid, oid });
    const read = (over: { cookie?: string } = {}, now?: number) => readTabSession("cookie" in over ? over.cookie : cookie, now);
    return { org, alice, app, tid, oid, cookie, read };
  }

  it("names the person it was issued for", async () => {
    const s = await setup();
    expect(await s.read()).toMatchObject({ orgId: s.org.id, userId: s.alice.id, slug: s.org.slug });
  });

  it("is refused tampered, foreign, missing or expired", async () => {
    const s = await setup();
    expect(await s.read({ cookie: undefined })).toBeNull();
    expect(await s.read({ cookie: s.cookie.slice(0, -4) + "AAAA" })).toBeNull();
    // Sealed by us, but not a tab session (any other sealed value).
    expect(await s.read({ cookie: sealSecret(JSON.stringify({ o: s.org.id, u: s.alice.id })) })).toBeNull();
    expect(await s.read({}, Date.now() + TAB_TTL_S * 1000 + 1000)).toBeNull();
    // Every field right, but sealed for another purpose.
    const exp = Math.floor(Date.now() / 1000) + 600;
    expect(await s.read({ cookie: sealSecret(JSON.stringify({ p: "other", o: s.org.id, u: s.alice.id, tid: s.tid, oid: s.oid, exp })) })).toBeNull();
  });

  it("names only the user it was issued to, even when the Microsoft account still maps to someone", async () => {
    const s = await setup();
    const bob = await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } });
    await prisma.orgMember.create({ data: { orgId: s.org.id, userId: bob.id, role: "MEMBER" } });
    const forBob = sealTabSession({ orgId: s.org.id, userId: bob.id, tid: s.tid, oid: s.oid }); // alice's Microsoft account
    expect(await s.read({ cookie: forBob })).toBeNull();
  });

  it("stops working when the person leaves, is deactivated, disconnects, or the app is switched off", async () => {
    let s = await setup();
    await prisma.orgMember.deleteMany({ where: { orgId: s.org.id, userId: s.alice.id } });
    expect(await s.read()).toBeNull();
    s = await setup();
    await prisma.connectorCredential.deleteMany({ where: { orgId: s.org.id, userId: s.alice.id } });
    expect(await s.read()).toBeNull();
    s = await setup();
    await prisma.integration.update({ where: { id: s.app.id }, data: { status: "INACTIVE" } });
    expect(await s.read()).toBeNull();
    s = await setup();
    await prisma.user.update({ where: { id: s.alice.id }, data: { deactivatedAt: new Date() } });
    try {
      expect(await s.read()).toBeNull();
    } finally {
      await prisma.user.update({ where: { id: s.alice.id }, data: { deactivatedAt: null } });
    }
  });

  it("the cookie is HttpOnly, Secure, SameSite=None, Partitioned, scoped to /teams/tab, for an hour", () => {
    const h = tabCookieHeader("abc");
    expect(h).toBe("teams_tab=abc; Path=/teams/tab; Max-Age=3600; HttpOnly; Secure; SameSite=None; Partitioned");
    expect(tabCookieHeader("")).toContain("Max-Age=0");
  });
});
