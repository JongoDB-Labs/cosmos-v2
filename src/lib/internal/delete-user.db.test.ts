// @vitest-environment node
//
// Deleting an account ends the person's credentials the way removing them from
// an org does: in each org they belong to, their API keys are deleted and their
// calendar links revoked, audited on that membership, in the same transaction
// as the deletion. Everyone else's stay.
//
// Against a real database. Own users and orgs: the seeded test users are
// shared by every DB spec running in parallel.
import { describe, it, expect, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { newFeedToken } from "@/lib/calendar/feed-token";
import { deleteUserAccount } from "./delete-user";

const stamp = Math.random().toString(36).slice(2, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

let n = 0;
async function org() {
  const i = ++n;
  const o = await prisma.organization.create({ data: { name: `dua ${stamp} ${i}`, slug: `dua-${stamp}-${i}` }, select: { id: true } });
  orgIds.push(o.id);
  return o.id;
}
async function user() {
  const k = ++n;
  const u = await prisma.user.create({ data: { email: `dua-${k}-${stamp}@delete.test`, displayName: `Delete person ${k} ${stamp}` } });
  userIds.push(u.id);
  return { id: u.id, email: u.email };
}
const join = async (orgId: string, userId: string) => (await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER" } })).id;
async function key(orgId: string, userId: string) {
  const keyHash = createHash("sha256").update(randomBytes(24)).digest("hex");
  return (await prisma.apiKey.create({
    data: { orgId, name: "fixture", prefix: randomBytes(6).toString("hex"), keyHash, scopes: ["read"], createdById: userId, projectIds: [] },
  })).id;
}
const link = async (orgId: string, userId: string) =>
  (await prisma.calendarFeed.create({ data: { orgId, userId, tokenHash: newFeedToken().tokenHash, options: {} } })).id;
const keyExists = async (id: string) => !!(await prisma.apiKey.findUnique({ where: { id }, select: { id: true } }));
const revokedAt = async (id: string) => (await prisma.calendarFeed.findUniqueOrThrow({ where: { id } })).revokedAt;

describe("deleting an account ends the person's keys and links", () => {
  it("in every org they belong to, audited on each membership; another person's stay", async () => {
    const [a, b] = [await org(), await org()];
    const admin = await user();
    const leaver = await user();
    const other = await user();
    const memberA = await join(a, leaver.id);
    const memberB = await join(b, leaver.id);
    await join(a, other.id);
    const keys = [await key(a, leaver.id), await key(b, leaver.id)];
    const links = [await link(a, leaver.id), await link(b, leaver.id)];
    const otherKey = await key(a, other.id);
    const otherLink = await link(a, other.id);
    for (const k of keys) expect(await keyExists(k)).toBe(true); // positive control

    await deleteUserAccount({ userId: leaver.id, email: leaver.email, actorUserId: admin.id });

    for (const k of keys) expect(await keyExists(k)).toBe(false);
    for (const l of links) expect(await revokedAt(l)).not.toBeNull();
    expect(await keyExists(otherKey)).toBe(true);
    expect(await revokedAt(otherLink)).toBeNull();

    for (const [orgId, memberId, linkId] of [[a, memberA, links[0]], [b, memberB, links[1]]] as const) {
      const keysAudit = await prisma.auditLog.findFirst({ where: { orgId, action: "member.api_keys_revoked", entityId: memberId } });
      expect(keysAudit).toMatchObject({ userId: admin.id, metadata: { targetUserId: leaver.id, reason: "account_deleted", revokedCount: 1 } });
      const linksAudit = await prisma.auditLog.findFirst({ where: { orgId, action: "member.calendar_feeds_revoked", entityId: memberId } });
      expect(linksAudit).toMatchObject({ userId: admin.id, metadata: { targetUserId: leaver.id, reason: "account_deleted", feedIds: [linkId] } });
    }
  });
});
