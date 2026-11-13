// @vitest-environment node
//
// Revoking a session deletes the person's sign-in everywhere, not only in this
// org, so it is a change to their access. It runs the ceiling on current role
// (src/lib/rbac/grant-ceiling.ts): the caller may revoke only the sessions of
// someone whose access they could have granted. Otherwise a member given
// SESSION_MANAGE by a work role could sign an owner out of every org.
// Against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { Permission, RolePermissions, maskToDb } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx }));

import { POST } from "./route";

type Role = "OWNER" | "ADMIN" | "MEMBER";
const stamp = Math.random().toString(36).slice(2, 8);
const users: string[] = [];
let orgId = "";
let n = 0;

async function person(role: Role) {
  n += 1;
  const userId = (
    await prisma.user.create({ data: { email: `sc-${n}-${stamp}@example.com`, displayName: `S${n}` } })
  ).id;
  users.push(userId);
  const memberId = (await prisma.orgMember.create({ data: { orgId, userId, role, permissions: "0" } })).id;
  return { userId, memberId };
}

/** A live sign-in for `userId`, recorded in this org's Sessions list. */
async function signedIn(userId: string) {
  const token = `sc-${stamp}-${Math.random().toString(36).slice(2)}-${"t".repeat(20)}`;
  const expiresAt = new Date(Date.now() + 3_600_000);
  await prisma.session.create({ data: { id: token, userId, expiresAt } });
  const record = await prisma.sessionRecord.create({ data: { orgId, userId, sessionToken: token, expiresAt } });
  return { token, recordId: record.id };
}

const as = (userId: string, role: Role, workRoleGrants = 0n): AuthContext => ({
  userId, orgId, orgRole: role, abacRules: [],
  basePermissions: RolePermissions[role],
  permissions: RolePermissions[role] | workRoleGrants,
});
const revoke = (body: unknown) =>
  POST(
    new NextRequest(`http://localhost/api/v1/orgs/${orgId}/security/sessions`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ orgId }) },
  );
const alive = async (token: string) => (await prisma.session.count({ where: { id: token } })) === 1;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `sc ${stamp}`, slug: `sc-${stamp}` } })).id;
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  await prisma.workRole.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

describe("revoking someone else's session runs the ceiling on current role", () => {
  it("the bit used below really is beyond a member (fixture check)", () => {
    expect(RolePermissions.MEMBER & Permission.SESSION_MANAGE).toBe(0n);
  });

  it("a member who manages sessions through a work role can't sign out an owner or an admin", async () => {
    const mgr = await person("MEMBER");
    const owner = await person("OWNER");
    const admin = await person("ADMIN");
    const o = await signedIn(owner.userId);
    const a = await signedIn(admin.userId);
    h.ctx = as(mgr.userId, "MEMBER", Permission.SESSION_MANAGE);
    expect((await revoke({ sessionIds: [o.recordId] })).status).toBe(403);
    expect((await revoke({ sessionIds: [a.recordId] })).status).toBe(403);
    expect(await alive(o.token)).toBe(true);
    expect(await alive(a.token)).toBe(true);
    expect((await prisma.sessionRecord.findUniqueOrThrow({ where: { id: o.recordId } })).status).toBe("ACTIVE");
  });

  it("one session beyond the caller refuses the whole request, so nothing is revoked", async () => {
    const mgr = await person("MEMBER");
    const owner = await person("OWNER");
    const plain = await person("MEMBER");
    const o = await signedIn(owner.userId);
    const p = await signedIn(plain.userId);
    h.ctx = as(mgr.userId, "MEMBER", Permission.SESSION_MANAGE);
    expect((await revoke({ sessionIds: [p.recordId, o.recordId] })).status).toBe(403);
    expect(await alive(p.token)).toBe(true);
    expect(await alive(o.token)).toBe(true);
  });

  it("counts the target's work roles", async () => {
    const mgr = await person("MEMBER");
    const target = await person("MEMBER");
    const role = await prisma.workRole.create({
      data: { orgId, key: `sc_sec_${stamp}`, name: `Sec ${stamp}`, grants: maskToDb(Permission.SECURITY_MANAGE) },
    });
    await prisma.orgMemberWorkRole.create({ data: { orgMemberId: target.memberId, workRoleId: role.id } });
    const t = await signedIn(target.userId);
    h.ctx = as(mgr.userId, "MEMBER", Permission.SESSION_MANAGE);
    expect((await revoke({ sessionIds: [t.recordId] })).status).toBe(403);
    expect(await alive(t.token)).toBe(true);
  });

  it("positive control: the same caller can sign out a plain member, and their own other devices", async () => {
    const mgr = await person("MEMBER");
    const plain = await person("MEMBER");
    const p = await signedIn(plain.userId);
    const mine = await signedIn(mgr.userId);
    h.ctx = as(mgr.userId, "MEMBER", Permission.SESSION_MANAGE);
    expect((await revoke({ sessionIds: [p.recordId] })).status).toBe(200);
    expect(await alive(p.token)).toBe(false);
    expect((await revoke({})).status).toBe(200);
    expect(await alive(mine.token)).toBe(false);
  });

  it("an admin can still sign out an admin, and only an owner can sign out an owner", async () => {
    const admin = await person("ADMIN");
    const other = await person("ADMIN");
    const owner = await person("OWNER");
    const theirs = await signedIn(other.userId);
    const ownerSession = await signedIn(owner.userId);
    h.ctx = as(admin.userId, "ADMIN");
    expect((await revoke({ sessionIds: [theirs.recordId] })).status).toBe(200);
    expect(await alive(theirs.token)).toBe(false);
    expect((await revoke({ sessionIds: [ownerSession.recordId] })).status).toBe(403);
    expect(await alive(ownerSession.token)).toBe(true);
    const otherOwner = await person("OWNER");
    h.ctx = as(otherOwner.userId, "OWNER");
    expect((await revoke({ sessionIds: [ownerSession.recordId] })).status).toBe(200);
    expect(await alive(ownerSession.token)).toBe(false);
  });
});

describe("revoking the session of someone no longer in this org", () => {
  // Their sign-in also serves the other orgs they belong to, and nobody here
  // holds a role over them any more. So it is revoked here only.
  it("marks it revoked here and leaves their sign-in elsewhere alone", async () => {
    const admin = await person("ADMIN");
    const gone = await person("OWNER");
    const plain = await person("MEMBER");
    const g = await signedIn(gone.userId);
    const p = await signedIn(plain.userId);
    await prisma.orgMember.update({ where: { id: gone.memberId }, data: { removedAt: new Date() } });
    h.ctx = as(admin.userId, "ADMIN");

    expect((await revoke({ sessionIds: [g.recordId, p.recordId] })).status).toBe(200);
    expect(await alive(g.token)).toBe(true);
    expect((await prisma.sessionRecord.findUniqueOrThrow({ where: { id: g.recordId } })).status).toBe("REVOKED");
    // positive control: a current member's sign-in in the same request ends
    expect(await alive(p.token)).toBe(false);
    expect((await prisma.sessionRecord.findUniqueOrThrow({ where: { id: p.recordId } })).status).toBe("REVOKED");
  });

  it("does the same for someone who was never a member here", async () => {
    const admin = await person("ADMIN");
    n += 1;
    const outsider = (
      await prisma.user.create({ data: { email: `sc-${n}-${stamp}@example.com`, displayName: `S${n}` } })
    ).id;
    users.push(outsider);
    const o = await signedIn(outsider);
    h.ctx = as(admin.userId, "ADMIN");
    expect((await revoke({ sessionIds: [o.recordId] })).status).toBe(200);
    expect(await alive(o.token)).toBe(true);
    expect((await prisma.sessionRecord.findUniqueOrThrow({ where: { id: o.recordId } })).status).toBe("REVOKED");
  });
});
