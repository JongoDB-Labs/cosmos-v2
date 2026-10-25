// @vitest-environment node
//
// A personal token's project ceiling can name only projects its member can
// see. A team-scoped project they aren't on answers as one that doesn't exist,
// so minting never confirms it, and naming only such projects is the same 400
// (an empty ceiling would mean org-wide). Against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";

const h = vi.hoisted(() => ({ userId: "", orgId: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: async () => ({ id: h.userId }),
  getAuthContext: async () => ({
    userId: h.userId, orgId: h.orgId, orgRole: "MEMBER", abacRules: [],
    permissions: RolePermissions.MEMBER, basePermissions: RolePermissions.MEMBER,
  }),
}));

import { POST } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
let restricted = "", open = "", outsider = "", insider = "";

beforeAll(async () => {
  outsider = (await prisma.user.create({ data: { email: `out-${stamp}@pat.test`, displayName: "Outsider" } })).id;
  insider = (await prisma.user.create({ data: { email: `in-${stamp}@pat.test`, displayName: "Insider" } })).id;
  h.orgId = (await prisma.organization.create({ data: { name: `pat ${stamp}`, slug: `pat-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId: h.orgId, userId: outsider, role: "MEMBER", permissions: "0" } });
  const insiderMembership = await prisma.orgMember.create({ data: { orgId: h.orgId, userId: insider, role: "MEMBER", permissions: "0" } });
  const key = stamp.slice(0, 3).toUpperCase();
  restricted = (await prisma.project.create({ data: { orgId: h.orgId, name: "R", key: `PR${key}`, teamScopedAccess: true } })).id;
  open = (await prisma.project.create({ data: { orgId: h.orgId, name: "O", key: `PO${key}` } })).id;
  await prisma.projectMember.create({ data: { projectId: restricted, orgMemberId: insiderMembership.id, role: "MEMBER" } });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: h.orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [outsider, insider] } } }).catch(() => undefined);
});

const mint = async (userId: string, projectIds: string[]) => {
  h.userId = userId;
  const res = await POST(
    new NextRequest("http://localhost/api/v1/me/tokens", {
      method: "POST",
      body: JSON.stringify({ orgId: h.orgId, name: "ci", scopes: ["read"], projectIds }),
    }),
  );
  return { status: res.status, record: ((await res.json()) as { record?: { projectIds: string[] } }).record };
};

describe("a personal token's project ceiling", () => {
  it("naming only a project the member can't see is the 400 for an unknown project, and mints nothing", async () => {
    const { status } = await mint(outsider, [restricted]);
    expect(status).toBe(400);
    expect(await prisma.apiKey.count({ where: { orgId: h.orgId, createdById: outsider } })).toBe(0);
  });

  it("a hidden project named alongside a visible one is dropped from the ceiling", async () => {
    const { status, record } = await mint(outsider, [restricted, open]);
    expect(status).toBe(201);
    expect(record?.projectIds).toEqual([open]);
  });

  it("the team names its own project as before", async () => {
    const { status, record } = await mint(insider, [restricted]);
    expect(status).toBe(201);
    expect(record?.projectIds).toEqual([restricted]);
  });
});
