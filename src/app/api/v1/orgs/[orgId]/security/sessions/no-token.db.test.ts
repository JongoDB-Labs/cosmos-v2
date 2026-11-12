// @vitest-environment node
//
// The org Sessions view lists device, address and time metadata. A session's
// token is the value of its sign-in cookie, so it must never be in the
// response: whoever could read it could set the cookie and be that person, in
// every org they belong to. Revoking works by the record's own id instead.
// Against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx }));

import { GET, POST } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
// Long and distinctive, so a substring search can't miss them.
const OWNER_TOKEN = `owner-cookie-${stamp}-${"x".repeat(24)}`;
const ADMIN_TOKEN = `admin-cookie-${stamp}-${"y".repeat(24)}`;
const MEMBER_TOKEN = `member-cookie-${stamp}-${"z".repeat(24)}`;
let orgId = "", ownerId = "", adminId = "", memberId = "", ownerRecordId = "", memberRecordId = "";

const req = (method: "GET" | "POST", body?: unknown) =>
  new NextRequest(`http://localhost/api/v1/orgs/${orgId}/security/sessions`, {
    method,
    headers: { cookie: `session=${ADMIN_TOKEN}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const at = () => ({ params: Promise.resolve({ orgId }) });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `sess ${stamp}`, slug: `sess-${stamp}` } })).id;
  ownerId = (await prisma.user.create({ data: { email: `o-${stamp}@sess.test`, displayName: "Owner" } })).id;
  adminId = (await prisma.user.create({ data: { email: `a-${stamp}@sess.test`, displayName: "Admin" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: adminId, role: "ADMIN", permissions: "0" } });
  memberId = (await prisma.user.create({ data: { email: `m-${stamp}@sess.test`, displayName: "Member" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: memberId, role: "MEMBER", permissions: "0" } });
  const expiresAt = new Date(Date.now() + 86_400_000);
  await prisma.session.create({ data: { id: OWNER_TOKEN, userId: ownerId, expiresAt } });
  await prisma.session.create({ data: { id: ADMIN_TOKEN, userId: adminId, expiresAt } });
  await prisma.session.create({ data: { id: MEMBER_TOKEN, userId: memberId, expiresAt } });
  memberRecordId = (
    await prisma.sessionRecord.create({
      data: { orgId, userId: memberId, sessionToken: MEMBER_TOKEN, expiresAt, userAgent: "Member browser" },
    })
  ).id;
  // The owner opened the Sessions page earlier, which recorded their session.
  ownerRecordId = (
    await prisma.sessionRecord.create({
      data: { orgId, userId: ownerId, sessionToken: OWNER_TOKEN, expiresAt, userAgent: "Owner browser" },
    })
  ).id;
  h.ctx = {
    userId: adminId, orgId, orgRole: "ADMIN", abacRules: [],
    permissions: RolePermissions.ADMIN, basePermissions: RolePermissions.ADMIN,
  } satisfies AuthContext;
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, adminId, memberId] } } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, adminId, memberId] } } });
});

describe("the org Sessions list", () => {
  it("lists the sessions, and carries no session token", async () => {
    const res = await GET(req("GET"), at());
    expect(res.status).toBe(200);
    const text = await res.text();

    // Positive control: the rows are there, including the owner's and the
    // caller's own (recorded on view), so absence below means something.
    const rows = JSON.parse(text) as { id: string; userId: string; isCurrent: boolean; userAgent: string | null }[];
    const owner = rows.find((r) => r.userId === ownerId);
    const mine = rows.find((r) => r.userId === adminId);
    expect(owner?.id).toBe(ownerRecordId);
    expect(owner?.userAgent).toBe("Owner browser");
    expect(owner?.isCurrent).toBe(false);
    expect(mine?.isCurrent).toBe(true);

    expect(text).not.toContain(OWNER_TOKEN);
    expect(text).not.toContain(ADMIN_TOKEN);
    expect(text).not.toContain(MEMBER_TOKEN);
    expect(text).not.toContain("sessionToken");
  });

  it("revokes a session by the record id it lists", async () => {
    // A member's: an admin may not sign out an owner (ceiling.db.test.ts).
    const res = await POST(req("POST", { sessionIds: [memberRecordId] }), at());
    expect(res.status).toBe(200);
    expect(await prisma.session.findUnique({ where: { id: MEMBER_TOKEN } })).toBeNull();
    expect((await prisma.sessionRecord.findUniqueOrThrow({ where: { id: memberRecordId } })).status).toBe("REVOKED");
    // The caller's own session is untouched.
    expect(await prisma.session.findUnique({ where: { id: ADMIN_TOKEN } })).not.toBeNull();
  });
});
