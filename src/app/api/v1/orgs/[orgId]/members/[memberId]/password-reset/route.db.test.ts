// @vitest-environment node
//
// Sending a member a password reset acts on their account, so it takes the
// same ceiling as changing or removing the member (grant-ceiling.ts): the
// caller may reach only someone whose current access they could have granted.
// Before, ORG_MANAGE_MEMBERS was the whole check, and a member who manages
// members through a work role could send a reset to an admin or an owner. Against a real database; only the
// caller and the mail send are stood in for. Own org and users throughout.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Vault key for sealing the reset token.
process.env.SSO_VAULT_KEY = Buffer.alloc(32, 21).toString("base64");

const caller = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => caller.ctx }));
const sent = vi.hoisted(() => [] as { toEmail: string }[]);
vi.mock("@/lib/integrations/invitation-email", () => ({
  sendPasswordResetEmail: vi.fn(async (p: { toEmail: string }) => {
    sent.push(p);
  }),
}));

import { prisma } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { Permission, RolePermissions, maskToDb } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { POST } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "";
const users: string[] = [];

type Who = "owner" | "owner2" | "admin" | "admin2" | "manager" | "member" | "elevated";
const people = {} as Record<Who, { userId: string; memberId: string; email: string }>;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Reset ${stamp}`, slug: `pwrc-${stamp}` } })).id;
  // A work role holding more than a member does, for a target whose role alone
  // would be within the manager's reach.
  const security = await prisma.workRole.create({
    data: { orgId, key: `security-${stamp}`, name: "Security", grants: maskToDb(Permission.SECURITY_MANAGE) },
  });
  const roles: Record<Who, "OWNER" | "ADMIN" | "MEMBER"> = {
    owner: "OWNER", owner2: "OWNER", admin: "ADMIN", admin2: "ADMIN",
    manager: "MEMBER", member: "MEMBER", elevated: "MEMBER",
  };
  for (const [who, role] of Object.entries(roles) as [Who, "OWNER" | "ADMIN" | "MEMBER"][]) {
    const email = `${who}-${stamp}@pwreset.test`;
    const userId = (await prisma.user.create({
      data: { email, displayName: who, passwordHash: hashPassword("old-passphrase-1234"), passwordSetAt: new Date() },
    })).id;
    users.push(userId);
    const memberId = (await prisma.orgMember.create({ data: { orgId, userId, role, permissions: "0" } })).id;
    if (who === "elevated") {
      await prisma.orgMemberWorkRole.create({ data: { orgMemberId: memberId, workRoleId: security.id } });
    }
    people[who] = { userId, memberId, email };
  }
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
});

beforeEach(() => {
  sent.length = 0;
});

/** An owner or admin, by role. */
const byRole = (who: "owner" | "admin"): AuthContext => {
  const role = who === "owner" ? "OWNER" : "ADMIN";
  return {
    userId: people[who].userId, orgId, orgRole: role, abacRules: [],
    permissions: RolePermissions[role], basePermissions: RolePermissions[role],
  };
};
/** A member who manages members only through a work role: their base is a member's. */
const workRoleManager = (): AuthContext => ({
  userId: people.manager.userId, orgId, orgRole: "MEMBER", abacRules: [],
  permissions: RolePermissions.MEMBER | Permission.ORG_MANAGE_MEMBERS,
  basePermissions: RolePermissions.MEMBER,
});

async function reset(ctx: AuthContext, target: Who) {
  caller.ctx = ctx;
  const res = await POST(new NextRequest("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ orgId, memberId: people[target].memberId }),
  });
  const audited = await prisma.auditLog.count({
    where: { orgId, action: "member.password_reset_sent", entityId: people[target].userId },
  });
  // The team table shows a refusal's `error` as it stands, so it must name a reset.
  const error = res.status === 403 ? ((await res.json()) as { error?: string }).error : undefined;
  return { status: res.status, mailedTo: sent.map((s) => s.toEmail), audited, error };
}

const OWNER_ONLY = "Only an owner can send a password reset to an owner.";
const BEYOND = "You can't send a password reset to someone whose access is beyond your own.";

describe("who may send a member a password reset", () => {
  it("an admin can't send one to an owner: refused, no mail, no audit row", async () => {
    const r = await reset(byRole("admin"), "owner");
    expect(r).toEqual({ status: 403, mailedTo: [], audited: 0, error: OWNER_ONLY });
  });

  it("an owner can send one to another owner", async () => {
    const r = await reset(byRole("owner"), "owner2");
    expect(r).toEqual({ status: 200, mailedTo: [people.owner2.email], audited: 1 });
  });

  it("an admin can send one to another admin, at their own level", async () => {
    const r = await reset(byRole("admin"), "admin2");
    expect(r).toEqual({ status: 200, mailedTo: [people.admin2.email], audited: 1 });
  });

  it("a member who manages members through a work role can't send one to an admin", async () => {
    const r = await reset(workRoleManager(), "admin");
    expect(r).toEqual({ status: 403, mailedTo: [], audited: 0, error: BEYOND });
  });

  it("nor to a member whose work roles hold more than the caller's base", async () => {
    const r = await reset(workRoleManager(), "elevated");
    expect(r).toEqual({ status: 403, mailedTo: [], audited: 0, error: BEYOND });
  });

  it("but can send one to a member at their own level", async () => {
    const r = await reset(workRoleManager(), "member");
    expect(r).toEqual({ status: 200, mailedTo: [people.member.email], audited: 1 });
  });
});
