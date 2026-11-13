// @vitest-environment node
//
// The whole-org JSON export lists every member with their user record. It
// loaded that record whole, so the archive carried each person's password hash
// and sealed MFA secret alongside their name. The export is a record of who
// works here, not of how they sign in.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", ownerId = "", memberId = "";

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `exj ${stamp}`, slug: `exj-${stamp}` } })).id;
  ownerId = (await prisma.user.create({ data: { email: `owner-${stamp}@exj.test`, displayName: "Owner" } })).id;
  memberId = (await prisma.user.create({
    data: {
      email: `member-${stamp}@exj.test`,
      displayName: "Member",
      passwordHash: `salt-${stamp}:hash-${stamp}`,
      mfaEnabled: true,
      mfaSecret: `sealed-${stamp}`,
      mfaRecoveryCodes: [`code-${stamp}`],
    },
  })).id;
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: memberId, role: "MEMBER", permissions: "0" } });
});

afterAll(async () => {
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
});

describe("GET export/json members", () => {
  it("carries each member's identity but none of their sign-in secrets", async () => {
    const permissions = RolePermissions.OWNER;
    h.ctx = { userId: ownerId, orgId, orgRole: "OWNER", abacRules: [], basePermissions: permissions, permissions } satisfies AuthContext;
    const res = await GET(new NextRequest(`http://localhost/api/v1/orgs/${orgId}/export/json`), { params: Promise.resolve({ orgId }) });
    expect(res.status).toBe(200);
    const text = await res.text();

    // Positive control: the member is in the archive, by name and email.
    const body = JSON.parse(text) as { members: Array<{ user: Record<string, unknown> }> };
    const member = body.members.find((m) => m.user.id === memberId);
    expect(member?.user).toMatchObject({ email: `member-${stamp}@exj.test`, displayName: "Member" });

    for (const secret of [`hash-${stamp}`, `sealed-${stamp}`, `code-${stamp}`]) expect(text).not.toContain(secret);
    expect(Object.keys(member!.user)).not.toEqual(expect.arrayContaining(["passwordHash"]));
    expect(Object.keys(member!.user)).not.toEqual(expect.arrayContaining(["mfaSecret"]));
  });
});
