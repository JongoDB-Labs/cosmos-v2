// @vitest-environment node
//
// Team membership and deletion. Both are access-control actions once
// teamScopedAccess is on — adding someone to a team can grant them sight of a
// restricted project — so both require canManageProject, not merely project
// edit rights.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole, ProjectRole } from "@prisma/client";

const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findFirst: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { findFirst: vi.fn() },
    team: { findFirst: vi.fn(), delete: vi.fn() },
    teamMember: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  },
  logAudit: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { POST, DELETE } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
// v4-shaped on purpose: zod 4 validates the UUID version and variant nibbles,
// so an all-same-digit placeholder is rejected as "Invalid UUID" — which reads
// as a route bug when it is really the fixture. gen_random_uuid() emits v4.
const TEAM_ID = "44444444-4444-4444-8444-444444444444";
const PM_ID = "55555555-5555-4555-8555-555555555555";

function ctx(perms = Permission.PROJECT_READ | Permission.PROJECT_MANAGE): AuthContext {
  return {
    userId: "33333333-3333-4333-8333-333333333333",
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  };
}
const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID, teamId: TEAM_ID });
const req = (body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method: body ? "POST" : "DELETE",
    ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.project.findFirst.mockResolvedValue({ id: PROJECT_ID, orgId: ORG_ID });
  prisma.team.findFirst.mockResolvedValue({ id: TEAM_ID, projectId: PROJECT_ID, name: "Alpha" });
  prisma.team.delete.mockResolvedValue({ id: TEAM_ID });
  // The person being added IS on this project.
  prisma.projectMember.findFirst.mockResolvedValue({ id: PM_ID, projectId: PROJECT_ID });
  prisma.teamMember.findFirst.mockResolvedValue(null);
  prisma.teamMember.create.mockResolvedValue({ id: "tm1" });
  prisma.teamMember.deleteMany.mockResolvedValue({ count: 1 });
  prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
  getAuthContext.mockResolvedValue(ctx());
});

describe("POST — add a member to a team", () => {
  it("adds a project member", async () => {
    const res = await POST(req({ projectMemberId: PM_ID }), { params });
    expect(res.status).toBe(201);
    expect(prisma.teamMember.create).toHaveBeenCalled();
  });

  it("403s a plain member", async () => {
    getAuthContext.mockResolvedValue(ctx(Permission.PROJECT_READ));
    prisma.projectMember.findFirst.mockResolvedValue(null); // not a MANAGER either
    const res = await POST(req({ projectMemberId: PM_ID }), { params });
    expect(res.status).toBe(403);
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
  });

  it("400s when the person is not on this project", async () => {
    // TeamMember FKs to ProjectMember, so this would otherwise be a raw FK
    // violation surfacing as a 500. It is also the invariant that matters:
    // you cannot be on a project's team without being on the project.
    prisma.projectMember.findFirst.mockResolvedValue(null);
    const res = await POST(req({ projectMemberId: PM_ID }), { params });
    expect(res.status).toBe(400);
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
  });

  it("is idempotent — adding someone already on the team is not an error", async () => {
    prisma.teamMember.findFirst.mockResolvedValue({ id: "tm-existing" });
    const res = await POST(req({ projectMemberId: PM_ID }), { params });
    expect(res.status).toBe(200);
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
  });

  it("404s for a team that belongs to another project", async () => {
    prisma.team.findFirst.mockResolvedValue(null);
    const res = await POST(req({ projectMemberId: PM_ID }), { params });
    expect(res.status).toBe(404);
  });
});

describe("DELETE — remove a member, or the whole team", () => {
  it("removes one member when given a projectMemberId", async () => {
    const url = `http://localhost/x?projectMemberId=${PM_ID}`;
    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), { params });
    expect(res.status).toBe(200);
    expect(prisma.teamMember.deleteMany).toHaveBeenCalled();
    expect(prisma.team.delete).not.toHaveBeenCalled();
  });

  it("deletes the team when given no member", async () => {
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(200);
    expect(prisma.team.delete).toHaveBeenCalled();
  });

  it("403s a plain member", async () => {
    getAuthContext.mockResolvedValue(ctx(Permission.PROJECT_READ));
    prisma.projectMember.findFirst.mockResolvedValue(null);
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(403);
    expect(prisma.team.delete).not.toHaveBeenCalled();
  });
});
