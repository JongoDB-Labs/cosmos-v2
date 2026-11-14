// @vitest-environment node
//
// A calendar link ends where the person's API keys end. Removing a member,
// reinstating one (re-adding them, or an SSO sign-in the identity provider
// still vouches for) and turning on Require MFA each end the links in the same
// transaction as the keys, with an audit row. A link is revoked, never deleted:
// `revokedAt` is what the feed and the list both treat as dead.
//
// Against a real database, through the real routes and the real feed renderer.
// Own users and orgs throughout: the seeded test users are shared by every DB
// spec running in parallel.
import { describe, it, expect, vi, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { patchOrgSettings } from "@/lib/org/patch-settings.server";
import { newFeedToken } from "@/lib/calendar/feed-token";
import { renderFeed } from "@/lib/calendar/feed.server";

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
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidateTag: () => undefined }));

import { POST as addMember } from "../members/route";
import { DELETE as removeMember } from "../members/[memberId]/route";
import { PUT as putSecurity } from "../security/settings/route";
import { completeSsoLogin, type SsoClaims } from "@/lib/auth/sso";

const stamp = Math.random().toString(36).slice(2, 8);
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = "https://example.com";
const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

type Person = { userId: string; memberId: string; session: string };
let n = 0;
async function org(opts: { tenantClass?: "GOV" | "COMMERCIAL" } = {}) {
  const i = ++n;
  const o = await prisma.organization.create({
    data: { name: `cfl ${stamp} ${i}`, slug: `cfl-${stamp}-${i}`, ...(opts.tenantClass && { tenantClass: opts.tenantClass }) },
    select: { id: true, slug: true },
  });
  orgIds.push(o.id);
  // The org's switch, written the way the settings route writes it.
  await patchOrgSettings(o.id, { merge: { key: "calendarFeeds", fields: { enabled: true } } });
  return o;
}
async function person(orgId: string, role: "ADMIN" | "MEMBER") {
  const k = ++n;
  const userId = (await prisma.user.create({ data: { email: `cfl-${k}-${stamp}@feeds.test`, displayName: `Feed person ${k} ${stamp}` } })).id;
  userIds.push(userId);
  const memberId = (await prisma.orgMember.create({ data: { orgId, userId, role } })).id;
  const session = randomBytes(24).toString("hex");
  await prisma.session.create({ data: { id: session, userId, expiresAt: new Date(Date.now() + DAY) } });
  return { userId, memberId, session } satisfies Person;
}
async function link(orgId: string, p: Person, extra: { revokedAt?: Date } = {}) {
  const { token, tokenHash } = newFeedToken();
  const { id } = await prisma.calendarFeed.create({ data: { orgId, userId: p.userId, tokenHash, options: {}, ...extra } });
  return { id, token, tokenHash };
}
const serves = async (token: string) => (await renderFeed(token, { origin: ORIGIN })) !== null;
const revokedAt = async (id: string) => (await prisma.calendarFeed.findUniqueOrThrow({ where: { id } })).revokedAt;

const asSession = (p: Person) => { h.headers = new Headers({ cookie: `session=${p.session}` }); };
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", { method, headers: h.headers, ...(body !== undefined && { body: JSON.stringify(body) }) });

describe("removing or reinstating a member ends their calendar links", () => {
  it("removal revokes their live links and audits it; re-adding them brings none back; other people's links are untouched", async () => {
    const o = await org();
    const admin = await person(o.id, "ADMIN");
    const leaver = await person(o.id, "MEMBER");
    const other = await person(o.id, "MEMBER");
    const leaving = await link(o.id, leaver);
    const earlier = new Date(Date.now() - 3 * DAY);
    const alreadyRevoked = await link(o.id, leaver, { revokedAt: earlier });
    const staying = await link(o.id, other);
    expect(await serves(leaving.token)).toBe(true); // positive control
    expect(await serves(staying.token)).toBe(true);

    asSession(admin);
    const removed = await removeMember(req("DELETE"), { params: Promise.resolve({ orgId: o.id, memberId: leaver.memberId }) });
    expect(removed.status).toBe(204);
    expect(await revokedAt(leaving.id)).not.toBeNull();
    // A link revoked before keeps the time it was revoked, and isn't counted.
    expect((await revokedAt(alreadyRevoked.id))?.getTime()).toBe(earlier.getTime());
    expect(await revokedAt(staying.id)).toBeNull();
    expect(await serves(staying.token)).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: { orgId: o.id, action: "member.calendar_feeds_revoked", entityId: leaver.memberId },
    });
    expect(audit?.metadata).toMatchObject({ targetUserId: leaver.userId, reason: "removed", revokedCount: 1, feedIds: [leaving.id] });
    expect(JSON.stringify(audit!.metadata)).not.toContain(leaving.tokenHash);

    // Re-adding reinstates the same membership row. The link stays dead.
    asSession(admin);
    expect((await addMember(req("POST", { userId: leaver.userId, role: "MEMBER" }), { params: Promise.resolve({ orgId: o.id }) })).status).toBe(201);
    expect(await prisma.orgMember.findUnique({ where: { id: leaver.memberId }, select: { id: true } })).not.toBeNull(); // reinstated
    expect(await serves(leaving.token)).toBe(false);
  });

  it("re-adding someone removed before removal revoked links revokes the links left on their row", async () => {
    const o = await org();
    const admin = await person(o.id, "ADMIN");
    const back = await person(o.id, "MEMBER");
    const old = await link(o.id, back);
    expect(await serves(old.token)).toBe(true); // positive control
    // Removed the old way: the row hidden, the link left live.
    await prismaUnfiltered.orgMember.update({ where: { id: back.memberId }, data: { removedAt: new Date() } });
    expect(await serves(old.token)).toBe(false);
    expect(await revokedAt(old.id)).toBeNull();

    asSession(admin);
    expect((await addMember(req("POST", { userId: back.userId, role: "MEMBER" }), { params: Promise.resolve({ orgId: o.id }) })).status).toBe(201);
    expect(await revokedAt(old.id)).not.toBeNull();
    expect(await serves(old.token)).toBe(false);
    const audit = await prisma.auditLog.findFirst({
      where: { orgId: o.id, action: "member.calendar_feeds_revoked", entityId: back.memberId },
    });
    expect(audit?.metadata).toMatchObject({ reason: "reinstated", revokedCount: 1, feedIds: [old.id] });
  });

  it("re-admitting a removed member through SSO revokes the links they made before the removal", async () => {
    const ISSUER = `https://idp-cfl-${stamp}.example.com`;
    const claims = (subject: string): SsoClaims =>
      ({ subject, email: null, emailVerified: false, groups: [], acr: null, amr: [], issuer: ISSUER }) as SsoClaims;
    const o = await org();
    // Enabled, not enforced: a link made without SSO would still be served.
    const conn = await prisma.idpConnection.create({
      data: { orgId: o.id, issuerUrl: ISSUER, clientId: "c", clientSecretEnc: "not-opened-by-these-tests", enabled: true },
    });
    const gone = await person(o.id, "MEMBER");
    const stays = await person(o.id, "MEMBER");
    for (const [p, sub] of [[gone, `g-${stamp}`], [stays, `t-${stamp}`]] as const) {
      await prisma.federatedIdentity.create({ data: { userId: p.userId, idpConnId: conn.id, subject: sub, issuer: ISSUER } });
    }
    const goneLink = await link(o.id, gone);
    const staysLink = await link(o.id, stays);
    await prismaUnfiltered.orgMember.update({ where: { id: gone.memberId }, data: { removedAt: new Date() } });

    expect((await completeSsoLogin(o.slug, conn, claims(`g-${stamp}`), {})).ok).toBe(true);
    expect(await prisma.orgMember.findUnique({ where: { id: gone.memberId }, select: { id: true } })).not.toBeNull(); // reinstated
    expect(await revokedAt(goneLink.id)).not.toBeNull();
    expect(await serves(goneLink.token)).toBe(false);
    const audit = await prisma.auditLog.findFirst({
      where: { orgId: o.id, action: "member.calendar_feeds_revoked", entityId: gone.memberId },
    });
    expect(audit?.metadata).toMatchObject({ reason: "reinstated", revokedCount: 1 });

    // Control: an SSO sign-in by someone never removed revokes nothing.
    expect((await completeSsoLogin(o.slug, conn, claims(`t-${stamp}`), {})).ok).toBe(true);
    expect(await revokedAt(staysLink.id)).toBeNull();
    expect(await serves(staysLink.token)).toBe(true);
  });
});

describe("turning on Require MFA ends the org's calendar links", () => {
  // COMMERCIAL, as keys go at this edge in every tenant class; a GOV org would
  // also sign everyone out.
  it("revokes every live link in the org, admins' included, audits it and reports the count; another org's links stay", async () => {
    const o = await org({ tenantClass: "COMMERCIAL" });
    const elsewhere = await org({ tenantClass: "COMMERCIAL" });
    const admin = await person(o.id, "ADMIN");
    const member = await person(o.id, "MEMBER");
    const outsider = await person(elsewhere.id, "MEMBER");
    const links = [await link(o.id, member), await link(o.id, admin)];
    const outside = await link(elsewhere.id, outsider);
    for (const l of links) expect(await serves(l.token)).toBe(true); // positive control
    const params = { params: Promise.resolve({ orgId: o.id }) };

    // Re-saving without tightening revokes nothing.
    asSession(admin);
    const unchanged = await putSecurity(req("PUT", { sessionTimeoutMins: 600 }), params);
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({ calendarFeedsRevoked: 0 });
    expect(await revokedAt(links[0].id)).toBeNull();

    asSession(admin);
    const res = await putSecurity(req("PUT", { mfaRequired: true }), { params: Promise.resolve({ orgId: o.id }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mfaRequired: true, calendarFeedsRevoked: 2 });
    for (const l of links) {
      expect(await revokedAt(l.id)).not.toBeNull();
      expect(await serves(l.token)).toBe(false);
    }
    expect(await revokedAt(outside.id)).toBeNull();
    expect(await serves(outside.token)).toBe(true);

    const audit = await prisma.auditLog.findFirst({ where: { orgId: o.id, action: "security_settings.calendar_feeds_revoked" } });
    expect(audit?.metadata).toMatchObject({ reason: "mfa_required", revokedCount: 2 });
    expect((audit!.metadata as { feedIds: string[] }).feedIds.sort()).toEqual(links.map((l) => l.id).sort());
  });
});
