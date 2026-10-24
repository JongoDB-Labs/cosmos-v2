// @vitest-environment node
//
// Making someone an owner, and keeping one. Only an owner may grant OWNER; the
// change is audited; and an organization always keeps an owner, even when two
// owners demote each other at the same moment. Against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

// Each request runs as its own caller, even when two run at once.
const caller = vi.hoisted(() => ({ als: null as AsyncLocalStorage<unknown> | null, ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => caller.als?.getStore() ?? caller.ctx }));

import { PUT } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
const users: string[] = [];
const orgs: string[] = [];

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
});

/** An org with members in the given roles; returns their user and member ids. */
async function orgWith(roles: ("OWNER" | "ADMIN" | "MEMBER")[]) {
  const orgId = (await prisma.organization.create({ data: { name: `own ${stamp}`, slug: `own-${stamp}-${orgs.length}` } })).id;
  orgs.push(orgId);
  const people = [];
  for (const [i, role] of roles.entries()) {
    const userId = (await prisma.user.create({ data: { email: `u${orgs.length}-${i}-${stamp}@own.test`, displayName: `Person ${i}` } })).id;
    users.push(userId);
    const memberId = (await prisma.orgMember.create({ data: { orgId, userId, role, permissions: "0" } })).id;
    people.push({ userId, memberId, role });
  }
  return { orgId, people };
}

const as = (orgId: string, p: { userId: string; role: "OWNER" | "ADMIN" | "MEMBER" }): AuthContext => ({
  userId: p.userId, orgId, orgRole: p.role, abacRules: [],
  permissions: RolePermissions[p.role], basePermissions: RolePermissions[p.role],
});
const setRole = (orgId: string, memberId: string, role: string) =>
  PUT(
    new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ role }), headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ orgId, memberId }) },
  );
const roleOf = async (memberId: string) => (await prisma.orgMember.findUniqueOrThrow({ where: { id: memberId } })).role;

beforeAll(() => { caller.als = new AsyncLocalStorage(); });

describe("making someone an owner", () => {
  it("an admin can't, and nothing changes", async () => {
    const { orgId, people: [, admin, member] } = await orgWith(["OWNER", "ADMIN", "MEMBER"]);
    caller.ctx = as(orgId, admin);
    expect((await setRole(orgId, member.memberId, "OWNER")).status).toBe(403);
    expect(await roleOf(member.memberId)).toBe("MEMBER");
  });

  it("an owner can, and the change is audited with the old and new role", async () => {
    const { orgId, people: [owner, member] } = await orgWith(["OWNER", "MEMBER"]);
    caller.ctx = as(orgId, owner);
    expect((await setRole(orgId, member.memberId, "OWNER")).status).toBe(200);
    expect(await roleOf(member.memberId)).toBe("OWNER");
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { orgId, action: "member.role_changed", entityId: member.memberId } });
    expect(entry).toMatchObject({ userId: owner.userId, metadata: expect.objectContaining({ oldRole: "MEMBER", newRole: "OWNER" }) });
  });

  it("with another owner left, an owner may still demote one", async () => {
    const { orgId, people: [a, b] } = await orgWith(["OWNER", "OWNER"]);
    caller.ctx = as(orgId, a);
    expect((await setRole(orgId, b.memberId, "ADMIN")).status).toBe(200);
    expect(await roleOf(b.memberId)).toBe("ADMIN");
  });
});

describe("an organization always keeps an owner", () => {
  it("two owners demoting each other at once: the second waits for the first, then is a 409", async () => {
    const { orgId, people: [a, b] } = await orgWith(["OWNER", "OWNER"]);
    // Hold the first demotion open (b demoting a, mid-transaction, with the
    // owner rows locked as the route locks them), and send the second (a
    // demoting b) while it is. Without the lock the second counts a as an owner
    // still, lands, and the org is left with none.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const first = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM org_members WHERE org_id = ${orgId}::uuid AND role = 'OWNER' AND removed_at IS NULL FOR UPDATE`;
      await tx.orgMember.update({ where: { id: a.memberId }, data: { role: "ADMIN" } });
      locked();
      await gate;
    }, { timeout: 20_000 });
    await isLocked;
    const second = caller.als!.run(as(orgId, a), () => setRole(orgId, b.memberId, "ADMIN"));
    await new Promise((r) => setTimeout(r, 300)); // let the second reach the lock
    release();
    await first;
    const res = await second;
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("conflict");
    expect(await prisma.orgMember.count({ where: { orgId, role: "OWNER" } })).toBe(1);
  });

  it("two owners racing for real: exactly one demotion lands", async () => {
    const { orgId, people: [a, b] } = await orgWith(["OWNER", "OWNER"]);
    const [resA, resB] = await Promise.all([
      caller.als!.run(as(orgId, a), () => setRole(orgId, b.memberId, "ADMIN")),
      caller.als!.run(as(orgId, b), () => setRole(orgId, a.memberId, "ADMIN")),
    ]);
    expect([resA.status, resB.status].sort()).toEqual([200, 409]);
    expect(await prisma.orgMember.count({ where: { orgId, role: "OWNER" } })).toBe(1);
  });
});
