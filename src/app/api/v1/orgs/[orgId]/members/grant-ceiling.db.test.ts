// @vitest-environment node
//
// Who may hand out an org role, on every path that sets one: adding a member
// (including reinstating a removed one), changing a member's role, and
// inviting. Two rules, against a real database:
//
//   1. Only an owner may make someone an owner.
//   2. Nobody may grant a role whose permissions go beyond their own base
//      permissions (role plus per-member override, never work-role grants).
//      That is the same ceiling work roles already have.
//
// The same ceiling applies to what someone holds NOW (the ceiling on current
// role): a caller may change or remove only a member, invitation or work role
// whose access they could have granted. Otherwise a member who manages members
// through a work role could demote or remove an admin they could never have
// made.
//
// Each refusal has a positive control: the same caller doing the allowed
// version of the same thing succeeds.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission, RolePermissions, maskToDb } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({
  getAuthContext: async () => h.ctx,
  // No signed-in inviter, so createOrgInvitation sends no mail.
  getCurrentUser: async () => null,
}));

import { POST as addMember } from "./route";
import { PUT as setRole } from "./[memberId]/route";
import { POST as invite } from "../invitations/route";
import { POST as resend, DELETE as revoke } from "../invitations/[invitationId]/route";
import { DELETE as removeMember } from "./[memberId]/route";
import { PUT as setWorkRoles } from "./[memberId]/work-roles/route";
import { PUT as editWorkRole, DELETE as deleteWorkRole } from "../work-roles/[roleId]/route";

type Role = "OWNER" | "ADMIN" | "BILLING_ADMIN" | "MEMBER" | "VIEWER" | "GUEST";

const stamp = Math.random().toString(36).slice(2, 8);
const users: string[] = [];
let orgId = "";
let n = 0;

async function person(role: Role | null) {
  n += 1;
  const userId = (
    await prisma.user.create({ data: { email: `gc-${n}-${stamp}@example.com`, displayName: `P${n}` } })
  ).id;
  users.push(userId);
  const memberId = role
    ? (await prisma.orgMember.create({ data: { orgId, userId, role, permissions: "0" } })).id
    : null;
  return { userId, memberId };
}

/** A session for `userId` holding `role`, optionally widened by a work role. */
function as(userId: string, role: Role, workRoleGrants = 0n): AuthContext {
  return {
    userId,
    orgId,
    orgRole: role,
    abacRules: [],
    basePermissions: RolePermissions[role],
    permissions: RolePermissions[role] | workRoleGrants,
  };
}

const json = (method: string, body: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
const post = (body: unknown) => addMember(json("POST", body), { params: Promise.resolve({ orgId }) });
const put = (memberId: string, role: Role) =>
  setRole(json("PUT", { role }), { params: Promise.resolve({ orgId, memberId }) });
const inviteAs = (email: string, role: Role) =>
  invite(json("POST", { email, role }), { params: Promise.resolve({ orgId }) });
const roleOf = async (memberId: string) =>
  (await prismaUnfiltered.orgMember.findUniqueOrThrow({ where: { id: memberId } })).role;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `gc ${stamp}`, slug: `gc-${stamp}` } })).id;
});

afterAll(async () => {
  await prisma.invitation.deleteMany({ where: { orgId } });
  await prisma.workRole.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.allowedEmail.deleteMany({ where: { email: { endsWith: `-${stamp}@example.com` } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

describe("adding a member", () => {
  it("an admin can't add someone as owner, and no row is written", async () => {
    const admin = await person("ADMIN");
    const target = await person(null);
    h.ctx = as(admin.userId, "ADMIN");
    expect((await post({ userId: target.userId, role: "OWNER" })).status).toBe(403);
    expect(await prismaUnfiltered.orgMember.count({ where: { orgId, userId: target.userId } })).toBe(0);
  });

  it("an admin can't reinstate a removed member as owner, and they stay removed", async () => {
    const admin = await person("ADMIN");
    const removed = await person("MEMBER");
    await prisma.orgMember.update({ where: { id: removed.memberId! }, data: { removedAt: new Date() } });
    h.ctx = as(admin.userId, "ADMIN");
    expect((await post({ userId: removed.userId, role: "OWNER" })).status).toBe(403);
    const row = await prismaUnfiltered.orgMember.findUniqueOrThrow({ where: { id: removed.memberId! } });
    expect(row.removedAt).not.toBeNull();
    expect(row.role).toBe("MEMBER");
  });

  it("positive control: an admin can add a member, and an owner can add an owner", async () => {
    const admin = await person("ADMIN");
    const owner = await person("OWNER");
    const a = await person(null);
    const b = await person(null);
    h.ctx = as(admin.userId, "ADMIN");
    expect((await post({ userId: a.userId, role: "MEMBER" })).status).toBe(201);
    h.ctx = as(owner.userId, "OWNER");
    expect((await post({ userId: b.userId, role: "OWNER" })).status).toBe(201);
  });

  it("a member who manages members through a work role can't add an admin", async () => {
    const manager = await person("MEMBER");
    const target = await person(null);
    h.ctx = as(manager.userId, "MEMBER", Permission.ORG_MANAGE_MEMBERS);
    expect((await post({ userId: target.userId, role: "ADMIN" })).status).toBe(403);
    expect(await prismaUnfiltered.orgMember.count({ where: { orgId, userId: target.userId } })).toBe(0);
    // ...but can add someone at their own level.
    expect((await post({ userId: target.userId, role: "MEMBER" })).status).toBe(201);
  });

  it("reinstating counts what the member would hold again, override included", async () => {
    const admin = await person("ADMIN");
    const removed = await person("MEMBER");
    // An override an owner (or an operator) gave them before they were removed.
    await prisma.orgMember.update({
      where: { id: removed.memberId! },
      data: { removedAt: new Date(), permissions: maskToDb(Permission.ORG_DELETE) },
    });
    h.ctx = as(admin.userId, "ADMIN");
    expect((await post({ userId: removed.userId, role: "MEMBER" })).status).toBe(403);
    expect(
      (await prismaUnfiltered.orgMember.findUniqueOrThrow({ where: { id: removed.memberId! } })).removedAt,
    ).not.toBeNull();
  });
});

describe("changing a member's role", () => {
  it("a member who manages members through a work role can't promote anyone to admin", async () => {
    const manager = await person("MEMBER");
    const target = await person("MEMBER");
    h.ctx = as(manager.userId, "MEMBER", Permission.ORG_MANAGE_MEMBERS);
    expect((await put(target.memberId!, "ADMIN")).status).toBe(403);
    expect(await roleOf(target.memberId!)).toBe("MEMBER");
  });

  it("positive control: the same caller can set a role within their own", async () => {
    const manager = await person("MEMBER");
    const target = await person("MEMBER");
    h.ctx = as(manager.userId, "MEMBER", Permission.ORG_MANAGE_MEMBERS);
    expect((await put(target.memberId!, "VIEWER")).status).toBe(200);
    expect(await roleOf(target.memberId!)).toBe("VIEWER");
  });

  it("an admin can still make someone an admin", async () => {
    const admin = await person("ADMIN");
    const target = await person("MEMBER");
    h.ctx = as(admin.userId, "ADMIN");
    expect((await put(target.memberId!, "ADMIN")).status).toBe(200);
    expect(await roleOf(target.memberId!)).toBe("ADMIN");
  });

  it("an admin can still make someone a billing admin (held open; see grant-ceiling.ts)", async () => {
    const admin = await person("ADMIN");
    const target = await person("MEMBER");
    h.ctx = as(admin.userId, "ADMIN");
    expect((await put(target.memberId!, "BILLING_ADMIN")).status).toBe(200);
    expect(await roleOf(target.memberId!)).toBe("BILLING_ADMIN");
  });

  it("an admin still can't make someone an owner", async () => {
    const admin = await person("ADMIN");
    const target = await person("MEMBER");
    h.ctx = as(admin.userId, "ADMIN");
    expect((await put(target.memberId!, "OWNER")).status).toBe(403);
    expect(await roleOf(target.memberId!)).toBe("MEMBER");
  });
});

describe("only an owner may grant the owner role, even when the ceiling would allow it", () => {
  // An admin an owner gave every owner-only bit: their base covers the owner
  // mask, so the permission ceiling alone would let them grant it. Only the
  // owner rule refuses, so these cases pin that rule on its own.
  const OWNER_EXTRAS = Permission.ORG_DELETE | Permission.ORG_MANAGE_BILLING | Permission.WORKFLOW_OVERRIDE;
  const fullAdmin = (userId: string): AuthContext => ({
    ...as(userId, "ADMIN"),
    basePermissions: RolePermissions.ADMIN | OWNER_EXTRAS,
    permissions: RolePermissions.ADMIN | OWNER_EXTRAS,
  });

  it("the fixture's base really covers the owner mask (fixture check)", () => {
    expect(RolePermissions.OWNER & ~(RolePermissions.ADMIN | OWNER_EXTRAS)).toBe(0n);
  });

  it("refuses adding, promoting, inviting and re-sending as owner", async () => {
    const admin = await person("ADMIN");
    const newcomer = await person(null);
    const member = await person("MEMBER");
    const lapsed = await prisma.invitation.create({
      data: { orgId, email: `gc-own-resend-${stamp}@example.com`, role: "OWNER", expiresAt: new Date(Date.now() - 60_000) },
    });
    h.ctx = fullAdmin(admin.userId);
    expect((await post({ userId: newcomer.userId, role: "OWNER" })).status).toBe(403);
    expect(await prismaUnfiltered.orgMember.count({ where: { orgId, userId: newcomer.userId } })).toBe(0);
    expect((await put(member.memberId!, "OWNER")).status).toBe(403);
    expect(await roleOf(member.memberId!)).toBe("MEMBER");
    const email = `gc-own-inv-${stamp}@example.com`;
    expect((await inviteAs(email, "OWNER")).status).toBe(403);
    expect(await prisma.invitation.count({ where: { orgId, email } })).toBe(0);
    expect((await resend(json("POST", {}), { params: Promise.resolve({ orgId, invitationId: lapsed.id }) })).status).toBe(403);
  });

  it("positive control: the same caller can add and promote to admin", async () => {
    const admin = await person("ADMIN");
    const newcomer = await person(null);
    const member = await person("MEMBER");
    h.ctx = fullAdmin(admin.userId);
    expect((await post({ userId: newcomer.userId, role: "ADMIN" })).status).toBe(201);
    expect((await put(member.memberId!, "ADMIN")).status).toBe(200);
  });
});

describe("inviting", () => {
  it("a member who manages members through a work role can't invite an admin", async () => {
    const manager = await person("MEMBER");
    h.ctx = as(manager.userId, "MEMBER", Permission.ORG_MANAGE_MEMBERS);
    const email = `gc-inv-admin-${stamp}@example.com`;
    expect((await inviteAs(email, "ADMIN")).status).toBe(403);
    expect(await prisma.invitation.count({ where: { orgId, email } })).toBe(0);
  });

  it("positive control: the same caller can invite a member", async () => {
    const manager = await person("MEMBER");
    h.ctx = as(manager.userId, "MEMBER", Permission.ORG_MANAGE_MEMBERS);
    const email = `gc-inv-member-${stamp}@example.com`;
    expect((await inviteAs(email, "MEMBER")).status).toBe(201);
    expect(await prisma.invitation.count({ where: { orgId, email } })).toBe(1);
  });

  it("an admin can still invite an admin", async () => {
    const admin = await person("ADMIN");
    h.ctx = as(admin.userId, "ADMIN");
    const email = `gc-inv-admin2-${stamp}@example.com`;
    expect((await inviteAs(email, "ADMIN")).status).toBe(201);
  });
});

describe("resending an invitation", () => {
  // Resending extends an invitation's life, even one that had lapsed, so it is
  // a grant too.
  async function ownerInvite(tag: string) {
    return prisma.invitation.create({
      data: {
        orgId,
        email: `gc-resend-${tag}-${stamp}@example.com`,
        role: "OWNER",
        expiresAt: new Date(Date.now() - 60_000), // lapsed
      },
    });
  }
  const resendAs = (invitationId: string) =>
    resend(json("POST", {}), { params: Promise.resolve({ orgId, invitationId }) });

  it("an admin can't revive an owner invitation, and it stays lapsed", async () => {
    const admin = await person("ADMIN");
    const inv = await ownerInvite("admin");
    h.ctx = as(admin.userId, "ADMIN");
    expect((await resendAs(inv.id)).status).toBe(403);
    const after = await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it("positive control: an owner can", async () => {
    const owner = await person("OWNER");
    const inv = await ownerInvite("owner");
    h.ctx = as(owner.userId, "OWNER");
    expect((await resendAs(inv.id)).status).toBe(200);
    const after = await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("the ceiling on current role", () => {
  // A member who manages members through a work role: their base permissions
  // are a MEMBER's, so an admin's access is beyond them.
  const manager = async () => {
    const m = await person("MEMBER");
    return as(m.userId, "MEMBER", Permission.ORG_MANAGE_MEMBERS);
  };
  const del = (memberId: string) =>
    removeMember(json("DELETE", {}), { params: Promise.resolve({ orgId, memberId }) });
  const removedAt = async (memberId: string) =>
    (await prismaUnfiltered.orgMember.findUniqueOrThrow({ where: { id: memberId } })).removedAt;
  /** A MEMBER with a stored override an owner gave them. */
  async function memberWithOverride(bits: bigint) {
    const p = await person("MEMBER");
    await prisma.orgMember.update({ where: { id: p.memberId! }, data: { permissions: maskToDb(bits) } });
    return p;
  }

  it("the override bit used below really is beyond a member (fixture check)", () => {
    expect(RolePermissions.MEMBER & Permission.SECURITY_MANAGE).toBe(0n);
    expect(RolePermissions.ADMIN & Permission.ORG_DELETE).toBe(0n);
  });

  it("can't demote an admin", async () => {
    const target = await person("ADMIN");
    h.ctx = await manager();
    expect((await put(target.memberId!, "VIEWER")).status).toBe(403);
    expect(await roleOf(target.memberId!)).toBe("ADMIN");
  });

  it("can't remove an admin", async () => {
    const target = await person("ADMIN");
    h.ctx = await manager();
    expect((await del(target.memberId!)).status).toBe(403);
    expect(await removedAt(target.memberId!)).toBeNull();
  });

  it("can't change or remove a member whose stored override is beyond theirs", async () => {
    const target = await memberWithOverride(Permission.SECURITY_MANAGE);
    h.ctx = await manager();
    expect((await put(target.memberId!, "VIEWER")).status).toBe(403);
    expect(await roleOf(target.memberId!)).toBe("MEMBER");
    expect((await del(target.memberId!)).status).toBe(403);
    expect(await removedAt(target.memberId!)).toBeNull();
  });

  it("positive control: the same caller can still change and remove a plain member", async () => {
    const a = await person("MEMBER");
    const b = await person("MEMBER");
    h.ctx = await manager();
    expect((await put(a.memberId!, "VIEWER")).status).toBe(200);
    expect(await roleOf(a.memberId!)).toBe("VIEWER");
    expect((await del(b.memberId!)).status).toBe(204);
    expect(await removedAt(b.memberId!)).not.toBeNull();
  });

  it("an admin can still change and remove another admin", async () => {
    const admin = await person("ADMIN");
    const a = await person("ADMIN");
    const b = await person("ADMIN");
    h.ctx = as(admin.userId, "ADMIN");
    expect((await put(a.memberId!, "MEMBER")).status).toBe(200);
    expect((await del(b.memberId!)).status).toBe(204);
  });

  it("an admin can't change or remove an admin an owner gave an owner-only bit", async () => {
    const admin = await person("ADMIN");
    const target = await person("ADMIN");
    await prisma.orgMember.update({
      where: { id: target.memberId! },
      data: { permissions: maskToDb(Permission.ORG_DELETE) },
    });
    h.ctx = as(admin.userId, "ADMIN");
    expect((await put(target.memberId!, "MEMBER")).status).toBe(403);
    expect((await del(target.memberId!)).status).toBe(403);
    expect(await roleOf(target.memberId!)).toBe("ADMIN");
    expect(await removedAt(target.memberId!)).toBeNull();
    // Positive control: an owner can.
    const owner = await person("OWNER");
    h.ctx = as(owner.userId, "OWNER");
    expect((await put(target.memberId!, "MEMBER")).status).toBe(200);
  });

  describe("revoking an invitation", () => {
    const invitation = (tag: string, role: Role) =>
      prisma.invitation.create({
        data: { orgId, email: `gc-rev-${tag}-${stamp}@example.com`, role, expiresAt: new Date(Date.now() + 86_400_000) },
      });
    const revokeAs = (invitationId: string) =>
      revoke(json("DELETE", {}), { params: Promise.resolve({ orgId, invitationId }) });
    const exists = async (id: string) => (await prisma.invitation.count({ where: { id } })) === 1;

    it("can't revoke an admin's invitation, and it stays", async () => {
      const inv = await invitation("admin", "ADMIN");
      h.ctx = await manager();
      expect((await revokeAs(inv.id)).status).toBe(403);
      expect(await exists(inv.id)).toBe(true);
    });

    it("an admin can't revoke an owner's invitation", async () => {
      const admin = await person("ADMIN");
      const inv = await invitation("owner", "OWNER");
      h.ctx = as(admin.userId, "ADMIN");
      expect((await revokeAs(inv.id)).status).toBe(403);
      expect(await exists(inv.id)).toBe(true);
    });

    it("positive control: the same caller can revoke a member's invitation, and an admin an admin's", async () => {
      const m = await invitation("member", "MEMBER");
      h.ctx = await manager();
      expect((await revokeAs(m.id)).status).toBe(204);
      expect(await exists(m.id)).toBe(false);
      const admin = await person("ADMIN");
      const a = await invitation("admin2", "ADMIN");
      h.ctx = as(admin.userId, "ADMIN");
      expect((await revokeAs(a.id)).status).toBe(204);
      expect(await exists(a.id)).toBe(false);
    });
  });

  describe("work roles", () => {
    let k = 0;
    const workRole = (grants: bigint) => {
      k += 1;
      return prisma.workRole.create({
        data: { orgId, key: `gc_wr_${k}_${stamp}`, name: `GC role ${k} ${stamp}`, grants: maskToDb(grants) },
      });
    };
    const assign = (orgMemberId: string, workRoleId: string) =>
      prisma.orgMemberWorkRole.create({ data: { orgMemberId, workRoleId } });
    const assigned = async (orgMemberId: string, workRoleId: string) =>
      (await prisma.orgMemberWorkRole.count({ where: { orgMemberId, workRoleId } })) === 1;
    const setRoles = (memberId: string, workRoleIds: string[]) =>
      setWorkRoles(json("PUT", { workRoleIds }), { params: Promise.resolve({ orgId, memberId }) });
    const at = (roleId: string) => ({ params: Promise.resolve({ orgId, roleId }) });

    it("the within-ceiling grant used below really is a member's (fixture check)", () => {
      expect(RolePermissions.MEMBER & Permission.ITEM_READ).toBe(Permission.ITEM_READ);
    });

    it("can't take away a work role whose grants are beyond theirs", async () => {
      const high = await workRole(Permission.SECURITY_MANAGE);
      const target = await person("MEMBER");
      await assign(target.memberId!, high.id);
      h.ctx = await manager();
      expect((await setRoles(target.memberId!, [])).status).toBe(403);
      expect(await assigned(target.memberId!, high.id)).toBe(true);
    });

    it("can't change or remove a member holding a work role beyond theirs, which would strip it", async () => {
      const high = await workRole(Permission.SECURITY_MANAGE | Permission.SESSION_MANAGE);
      const target = await person("MEMBER");
      await assign(target.memberId!, high.id);
      h.ctx = await manager();
      expect((await put(target.memberId!, "VIEWER")).status).toBe(403);
      expect(await roleOf(target.memberId!)).toBe("MEMBER");
      expect((await del(target.memberId!)).status).toBe(403);
      expect(await removedAt(target.memberId!)).toBeNull();
      expect(await assigned(target.memberId!, high.id)).toBe(true);
    });

    it("positive control: can change and remove a member whose work roles are within their own", async () => {
      const low = await workRole(Permission.ITEM_READ);
      const a = await person("MEMBER");
      const b = await person("MEMBER");
      await assign(a.memberId!, low.id);
      await assign(b.memberId!, low.id);
      h.ctx = await manager();
      expect((await put(a.memberId!, "VIEWER")).status).toBe(200);
      expect((await del(b.memberId!)).status).toBe(204);
      expect(await removedAt(b.memberId!)).not.toBeNull();
    });

    it("positive control: can take away one within their own", async () => {
      const low = await workRole(Permission.ITEM_READ);
      const target = await person("MEMBER");
      await assign(target.memberId!, low.id);
      h.ctx = await manager();
      expect((await setRoles(target.memberId!, [])).status).toBe(200);
      expect(await assigned(target.memberId!, low.id)).toBe(false);
    });

    it("can't edit or delete a work role whose grants are beyond theirs", async () => {
      const high = await workRole(Permission.SECURITY_MANAGE);
      h.ctx = await manager();
      expect((await editWorkRole(json("PUT", { name: `renamed ${stamp}` }), at(high.id))).status).toBe(403);
      expect((await editWorkRole(json("PUT", { grants: [] }), at(high.id))).status).toBe(403);
      expect((await deleteWorkRole(json("DELETE", {}), at(high.id))).status).toBe(403);
      const after = await prisma.workRole.findUniqueOrThrow({ where: { id: high.id } });
      expect(after.name).toBe(high.name);
      expect(after.grants).toBe(high.grants);
    });

    it("positive control: can edit and delete one within their own", async () => {
      const low = await workRole(Permission.ITEM_READ);
      h.ctx = await manager();
      expect((await editWorkRole(json("PUT", { name: `renamed low ${stamp}` }), at(low.id))).status).toBe(200);
      expect((await deleteWorkRole(json("DELETE", {}), at(low.id))).status).toBe(204);
      expect(await prisma.workRole.count({ where: { id: low.id } })).toBe(0);
    });
  });
});
