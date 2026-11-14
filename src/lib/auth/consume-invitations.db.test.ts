// @vitest-environment node
//
// Inviting back someone who was removed brings their membership back: the SAME
// row, as re-adding them from the members list does, with the invitation's
// role. And an invitation is matched to the person signing in by their exact
// address, ignoring case only.
//
// Real database, real routes: the members DELETE removes, the invitations POST
// invites, and the password sign-in accepts (it consumes pending invitations,
// as the Google and Microsoft sign-ins do). The stand-ins are the session the
// two admin routes ask for, and the request headers.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getAuthContext: async () => h.ctx,
  // No signed-in inviter, so createOrgInvitation sends no mail.
  getCurrentUser: async () => null,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
  headers: async () => new Headers(),
}));

import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { Permission, RolePermissions, maskToDb } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { POST as passwordLogin } from "@/app/api/auth/password/login/route";
import { POST as inviteRoute } from "@/app/api/v1/orgs/[orgId]/invitations/route";
import { POST as resendRoute } from "@/app/api/v1/orgs/[orgId]/invitations/[invitationId]/route";
import { DELETE as removeRoute } from "@/app/api/v1/orgs/[orgId]/members/[memberId]/route";
import { POST as addRoute } from "@/app/api/v1/orgs/[orgId]/members/route";
import { consumePendingInvitations } from "./consume-invitations";
import { addOrReinstateMember, membershipRow } from "@/lib/members/add-member.server";

const stamp = Math.random().toString(36).slice(2, 8);
const DOM = `readd-${stamp}.test`;
const PASSWORD = `readd ${stamp} passphrase`;

type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
let orgId = "";
const otherOrgs: string[] = [];
let owner = "";
let admin = "";
const userIds: string[] = [];

async function account(email: string) {
  const u = await prisma.user.create({
    data: { email, displayName: email.split("@")[0], passwordHash: hashPassword(PASSWORD), passwordSetAt: new Date() },
  });
  userIds.push(u.id);
  return u.id;
}
const join = async (userId: string, role: Role) =>
  (await prisma.orgMember.create({ data: { orgId, userId, role, permissions: "0" } })).id;
const workRole = async (grants: bigint) =>
  (await prisma.workRole.create({ data: { orgId, key: `wr-${randomBytes(4).toString("hex")}`, name: "Role", grants: maskToDb(grants) } })).id;
/** An API key row made by `userId` in this org. */
async function keyOf(userId: string) {
  const prefix = randomBytes(6).toString("hex");
  return (await prisma.apiKey.create({
    data: {
      orgId, name: "k", prefix, keyHash: createHash("sha256").update(randomBytes(24)).digest("hex"),
      scopes: ["read"], createdById: userId, projectIds: [],
    },
  })).id;
}

function as(userId: string, role: Role): AuthContext {
  return { userId, orgId, orgRole: role, abacRules: [], basePermissions: RolePermissions[role], permissions: RolePermissions[role] };
}

let ipSeq = 0;
const request = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${Math.floor(Math.random() * 250)}.${++ipSeq}` },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const remove = (memberId: string) => removeRoute(request("DELETE"), { params: Promise.resolve({ orgId, memberId }) });
const invite = (body: Record<string, unknown>) => inviteRoute(request("POST", body), { params: Promise.resolve({ orgId }) });
const add = (userId: string, role: Role) => addRoute(request("POST", { userId, role }), { params: Promise.resolve({ orgId }) });
const resend = (invitationId: string) => resendRoute(request("POST"), { params: Promise.resolve({ orgId, invitationId }) });
const signIn = (email: string) => passwordLogin(request("POST", { email, password: PASSWORD }));
const rowsOf = (userId: string) => prismaUnfiltered.orgMember.findMany({ where: { orgId, userId } });
const inviteRow = (email: string) =>
  prisma.invitation.create({ data: { orgId, email, expiresAt: new Date(Date.now() + 86_400_000) } });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Readd ${stamp}`, slug: `readd-${stamp}` } })).id;
  owner = await account(`owner.${stamp}@${DOM}`);
  await join(owner, "OWNER");
  admin = await account(`admin.${stamp}@${DOM}`);
  await join(admin, "ADMIN");
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, ...otherOrgs] } } });
  await prisma.allowedEmail.deleteMany({ where: { email: { endsWith: `@${DOM}` } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("inviting a removed member back", () => {
  it("reinstates their own membership row with the invitation's role, its work roles intact and its keys ended", async () => {
    const email = `returner.${stamp}@${DOM}`;
    const userId = await account(email);
    const memberId = await join(userId, "MEMBER");
    const retained = await workRole(Permission.ITEM_CREATE);
    await prisma.orgMemberWorkRole.create({ data: { orgMemberId: memberId, workRoleId: retained } });
    const madeBefore = await keyOf(userId);

    h.ctx = as(owner, "OWNER");
    expect((await remove(memberId)).status).toBe(204);
    // Positive controls: the removal happened, and it ended their key.
    expect((await rowsOf(userId))[0].removedAt).not.toBeNull();
    expect(await prisma.apiKey.count({ where: { id: madeBefore } })).toBe(0);
    // A key left on the row by a removal from before removals ended keys.
    const leftOver = await keyOf(userId);

    const invited = await invite({ email, role: "VIEWER" });
    expect(invited.status).toBe(201);
    const { invitation, existingAccount } = (await invited.json()) as { invitation: { id: string }; existingAccount: boolean };
    expect(existingAccount).toBe(true);

    expect((await signIn(email)).status).toBe(200);

    const rows = await rowsOf(userId);
    expect(rows.map((r) => ({ id: r.id, removedAt: r.removedAt, role: r.role }))).toEqual([
      { id: memberId, removedAt: null, role: "VIEWER" },
    ]);
    // The default client counts them as a member again.
    expect(await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId, userId } } })).not.toBeNull();
    expect(await prisma.invitation.count({ where: { id: invitation.id } })).toBe(0);
    expect(await prisma.orgMemberWorkRole.count({ where: { orgMemberId: memberId, workRoleId: retained } })).toBe(1);
    expect(await prisma.apiKey.count({ where: { id: { in: [madeBefore, leftOver] } } })).toBe(0);
    const ended = await prisma.auditLog.findFirst({
      where: { orgId, action: "member.api_keys_revoked", entityId: memberId, metadata: { path: ["reason"], equals: "reinstated" } },
    });
    expect(ended?.metadata).toMatchObject({ revokedCount: 1 });
  });

  it("audits the reinstatement as the members list does, with the person accepting as the actor", async () => {
    const email = `audited.${stamp}@${DOM}`;
    const userId = await account(email);
    const memberId = await join(userId, "MEMBER");
    h.ctx = as(owner, "OWNER");
    expect((await remove(memberId)).status).toBe(204);
    expect((await invite({ email, role: "MEMBER" })).status).toBe(201);
    expect((await signIn(email)).status).toBe(200);

    const rows = await prisma.auditLog.findMany({ where: { orgId, entityId: memberId, action: { in: ["member.reinstated", "member.added"] } } });
    expect(rows.map((r) => ({ action: r.action, userId: r.userId, metadata: r.metadata }))).toEqual([
      { action: "member.reinstated", userId, metadata: expect.objectContaining({ targetUserId: userId, role: "MEMBER" }) },
    ]);
  });

  it("an admin can't invite back someone whose retained work role goes beyond their own; an owner can", async () => {
    const email = `beyond.${stamp}@${DOM}`;
    const userId = await account(email);
    const memberId = await join(userId, "MEMBER");
    await prisma.orgMemberWorkRole.create({ data: { orgMemberId: memberId, workRoleId: await workRole(Permission.ORG_DELETE) } });
    await prismaUnfiltered.orgMember.update({ where: { id: memberId }, data: { removedAt: new Date() } });

    h.ctx = as(admin, "ADMIN");
    expect((await invite({ email, role: "MEMBER" })).status).toBe(403);
    expect(await prisma.invitation.count({ where: { orgId, email } })).toBe(0);
    // Positive control: the same invitation from an owner, whose base covers it.
    h.ctx = as(owner, "OWNER");
    expect((await invite({ email, role: "MEMBER" })).status).toBe(201);
  });

  it("an admin can't resend an invitation that would bring back access beyond their own; an owner can", async () => {
    const email = `resent.${stamp}@${DOM}`;
    const userId = await account(email);
    const memberId = await join(userId, "MEMBER");
    await prisma.orgMemberWorkRole.create({ data: { orgMemberId: memberId, workRoleId: await workRole(Permission.ORG_DELETE) } });
    await prismaUnfiltered.orgMember.update({ where: { id: memberId }, data: { removedAt: new Date() } });
    const { id } = await inviteRow(email);

    h.ctx = as(admin, "ADMIN");
    expect((await resend(id)).status).toBe(403);
    h.ctx = as(owner, "OWNER");
    expect((await resend(id)).status).toBe(200);
  });

  it("an invitation to someone who is still a member is cleared and changes nothing", async () => {
    const email = `current.${stamp}@${DOM}`;
    const userId = await account(email);
    const memberId = await join(userId, "MEMBER");
    const { id } = await inviteRow(email);
    await prisma.invitation.update({ where: { id }, data: { role: "ADMIN" } });

    expect((await signIn(email)).status).toBe(200);
    expect((await rowsOf(userId)).map((r) => ({ id: r.id, role: r.role, removedAt: r.removedAt }))).toEqual([
      { id: memberId, role: "MEMBER", removedAt: null },
    ]);
    expect(await prisma.invitation.count({ where: { id } })).toBe(0);
  });
});

describe("a brand-new member accepting an invitation (positive control)", () => {
  it("joins with the invitation's role and work roles, and the invitation is consumed", async () => {
    const email = `newcomer.${stamp}@${DOM}`;
    const userId = await account(email);
    const chosen = await workRole(Permission.ITEM_CREATE);
    h.ctx = as(owner, "OWNER");
    const invited = await invite({ email, role: "MEMBER", workRoleIds: [chosen] });
    expect(invited.status).toBe(201);
    const { invitation } = (await invited.json()) as { invitation: { id: string } };

    expect((await signIn(email)).status).toBe(200);
    const rows = await rowsOf(userId);
    expect(rows.map((r) => ({ role: r.role, removedAt: r.removedAt }))).toEqual([{ role: "MEMBER", removedAt: null }]);
    expect(await prisma.orgMemberWorkRole.count({ where: { orgMemberId: rows[0].id, workRoleId: chosen } })).toBe(1);
    expect(await prisma.invitation.count({ where: { id: invitation.id } })).toBe(0);
  });

  it("is audited as an added member", async () => {
    const email = `added.${stamp}@${DOM}`;
    const userId = await account(email);
    h.ctx = as(owner, "OWNER");
    expect((await invite({ email, role: "MEMBER" })).status).toBe(201);
    expect((await signIn(email)).status).toBe(200);
    const [row] = await rowsOf(userId);
    const audit = await prisma.auditLog.findMany({ where: { orgId, entityId: row.id, action: { in: ["member.reinstated", "member.added"] } } });
    expect(audit.map((a) => ({ action: a.action, userId: a.userId }))).toEqual([{ action: "member.added", userId }]);
  });
});

describe("an invitation matches the exact address, ignoring case", () => {
  it("an invitation to Mixed.Case@… is accepted by the account mixed.case@…", async () => {
    const lower = `mixed.case.${stamp}@${DOM}`;
    const userId = await account(lower);
    const { id } = await inviteRow(`Mixed.Case.${stamp}@${DOM}`);

    expect((await signIn(lower)).status).toBe(200);
    expect((await rowsOf(userId)).map((r) => r.removedAt)).toEqual([null]);
    expect(await prisma.invitation.count({ where: { id } })).toBe(0);
  });

  it("an account whose stored address has capitals accepts its lowercased invitation (the Google and Microsoft sign-ins pass the stored address)", async () => {
    const stored = `Stored.Case.${stamp}@${DOM}`;
    const userId = await account(stored);
    h.ctx = as(owner, "OWNER");
    expect((await invite({ email: stored, role: "MEMBER" })).status).toBe(201);
    expect(await prisma.invitation.count({ where: { orgId, email: stored.toLowerCase() } })).toBe(1);

    await consumePendingInvitations(userId, stored);
    expect((await rowsOf(userId)).map((r) => r.removedAt)).toEqual([null]);
  });

  it("an address one character away does not match: an underscore is not a wildcard", async () => {
    const theirs = `near.${stamp}@${DOM}`;
    const mine = `near_${stamp}@${DOM}`;
    const userId = await account(mine);
    const { id } = await inviteRow(theirs);

    expect((await signIn(mine)).status).toBe(200);
    expect(await rowsOf(userId)).toEqual([]);
    expect(await prisma.invitation.count({ where: { id } })).toBe(1);
  });
});

describe("the shared write meets a row it was not told about", () => {
  // `existing: null` stands for a read made before a concurrent request
  // created the row (a second sign-in tab, a double-clicked Add).
  it("a current membership made meanwhile means they are in: nothing is written", async () => {
    const userId = await account(`raced.${stamp}@${DOM}`);
    const memberId = await join(userId, "MEMBER");
    const joined = await addOrReinstateMember({ orgId, userId, role: "ADMIN", existing: null, actorUserId: userId });
    expect(joined).toBeNull();
    expect((await rowsOf(userId)).map((r) => ({ id: r.id, role: r.role }))).toEqual([{ id: memberId, role: "MEMBER" }]);
  });

  it("a removed row is not that race: the unique violation is thrown, not swallowed", async () => {
    const userId = await account(`stale.${stamp}@${DOM}`);
    const memberId = await join(userId, "MEMBER");
    await prismaUnfiltered.orgMember.update({ where: { id: memberId }, data: { removedAt: new Date() } });
    await expect(
      addOrReinstateMember({ orgId, userId, role: "MEMBER", existing: null, actorUserId: userId }),
    ).rejects.toMatchObject({ code: "P2002" });
    // Positive control: given the row it was meant to read, the same call reinstates it.
    const joined = await addOrReinstateMember({
      orgId, userId, role: "MEMBER", existing: await membershipRow(orgId, userId), actorUserId: userId,
    });
    expect(joined).toMatchObject({ reinstated: true, member: { id: memberId } });
  });
});

describe("an invitation from before a removal does not undo it", () => {
  it("an invitation sent before an admin added and then removed the person does not bring them back", async () => {
    const email = `added-then-removed.${stamp}@${DOM}`;
    const userId = await account(email);
    h.ctx = as(owner, "OWNER");
    const invited = await invite({ email, role: "MEMBER" });
    expect(invited.status).toBe(201);
    const { invitation } = (await invited.json()) as { invitation: { id: string } };
    expect((await add(userId, "MEMBER")).status).toBe(201);
    const [row] = await rowsOf(userId);
    expect((await remove(row.id)).status).toBe(204);

    expect((await signIn(email)).status).toBe(200);
    expect((await rowsOf(userId)).map((r) => ({ id: r.id, removed: r.removedAt !== null }))).toEqual([
      { id: row.id, removed: true },
    ]);
    expect(await prisma.invitation.count({ where: { id: invitation.id } })).toBe(0);
  });

  it("an invitation left from before the removal is deleted at sign-in, and they stay removed", async () => {
    const email = `left-over.${stamp}@${DOM}`;
    const userId = await account(email);
    const memberId = await join(userId, "MEMBER");
    h.ctx = as(owner, "OWNER");
    expect((await remove(memberId)).status).toBe(204);
    const [{ removedAt }] = await rowsOf(userId);
    // As made before removals ended invitations: issued a minute before it.
    const { id } = await prisma.invitation.create({
      data: { orgId, email, createdAt: new Date(removedAt!.getTime() - 60_000), expiresAt: new Date(Date.now() + 86_400_000) },
    });

    expect((await signIn(email)).status).toBe(200);
    expect((await rowsOf(userId)).map((r) => r.removedAt)).toEqual([removedAt]);
    expect(await prisma.invitation.count({ where: { id } })).toBe(0);
  });

  it("removing someone deletes their invitations to that org, expired ones too, matched by exact address ignoring case", async () => {
    const email = `leaver_${stamp}@${DOM}`;
    const userId = await account(email);
    const memberId = await join(userId, "MEMBER");
    const other = (await prisma.organization.create({ data: { name: `Other ${stamp}`, slug: `readd-other-${stamp}` } })).id;
    otherOrgs.push(other);
    const later = new Date(Date.now() + 86_400_000);
    const mine = await prisma.invitation.create({ data: { orgId, email: email.toUpperCase(), expiresAt: later } });
    const lapsed = await prisma.invitation.create({ data: { orgId, email, expiresAt: new Date(Date.now() - 60_000) } });
    // Someone else's address one character away, and the same address in another org.
    const near = await prisma.invitation.create({ data: { orgId, email: `leaver.${stamp}@${DOM}`, expiresAt: later } });
    const elsewhere = await prisma.invitation.create({ data: { orgId: other, email, expiresAt: later } });

    h.ctx = as(owner, "OWNER");
    expect((await remove(memberId)).status).toBe(204);
    const left = await prisma.invitation.findMany({ where: { id: { in: [mine.id, lapsed.id, near.id, elsewhere.id] } }, select: { id: true } });
    expect(left.map((i) => i.id).sort()).toEqual([near.id, elsewhere.id].sort());
    const audit = await prisma.auditLog.findFirst({ where: { orgId, action: "member.removed", entityId: memberId } });
    expect(audit?.metadata).toMatchObject({ invitationsEnded: "2" });
  });

  it("resending an invitation from before the removal is refused: the admin sends a new one", async () => {
    const email = `resend-stale.${stamp}@${DOM}`;
    const userId = await account(email);
    const memberId = await join(userId, "MEMBER");
    h.ctx = as(owner, "OWNER");
    expect((await remove(memberId)).status).toBe(204);
    const [{ removedAt }] = await rowsOf(userId);
    const expiresAt = new Date(Date.now() + 3_600_000);
    const { id } = await prisma.invitation.create({
      data: { orgId, email, createdAt: new Date(removedAt!.getTime() - 60_000), expiresAt },
    });

    const res = await resend(id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/new invitation/i);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id } })).expiresAt).toEqual(expiresAt);
  });
});
