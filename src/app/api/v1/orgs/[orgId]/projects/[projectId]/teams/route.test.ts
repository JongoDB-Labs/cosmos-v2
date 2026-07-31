// @vitest-environment node
//
// Team CRUD for a project. #35 makes core own teams; this is the surface that
// lets anyone actually create one, which is what has been missing — the model
// and the read-scoping shipped with no way to populate them.
//
// The authz decision runs FOR REAL (canManageProject against a crafted
// AuthContext + mocked prisma): teams decide who can see a project once
// teamScopedAccess is on, so who may edit them is the load-bearing question.
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
    team: { findMany: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
  },
  logAudit: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { GET, POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR = "33333333-3333-3333-3333-333333333333";

function ctx(over: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: ACTOR,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions: Permission.PROJECT_READ,
    basePermissions: Permission.PROJECT_READ,
    abacRules: [],
    ...over,
  };
}
const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID });
const postReq = (body: unknown) =>
  new NextRequest("http://localhost/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.project.findFirst.mockResolvedValue({ id: PROJECT_ID, orgId: ORG_ID, teamScopedAccess: false });
  prisma.team.findMany.mockResolvedValue([]);
  prisma.team.findFirst.mockResolvedValue(null);
  prisma.team.create.mockResolvedValue({ id: "t1", name: "Alpha", key: null, projectId: PROJECT_ID });
  // Not a project manager unless a test says so.
  prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
  prisma.projectMember.findFirst.mockResolvedValue(null);
});

describe("GET teams", () => {
  it("lists teams for a reader", async () => {
    getAuthContext.mockResolvedValue(ctx());
    const res = await GET(new NextRequest("http://localhost/x"), { params });
    expect(res.status).toBe(200);
  });

  it("401s when unauthenticated", async () => {
    getAuthContext.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/x"), { params });
    expect(res.status).toBe(401);
  });
});

describe("POST teams — who may create one", () => {
  it("403s a plain member", async () => {
    // A team gates project visibility once teamScopedAccess is on, so creating
    // one is a management action, not something any reader may do.
    getAuthContext.mockResolvedValue(ctx());
    const res = await POST(postReq({ name: "Alpha" }), { params });
    expect(res.status).toBe(403);
    expect(prisma.team.create).not.toHaveBeenCalled();
  });

  it("allows an org ADMIN — org-wide administration, from the org role", async () => {
    // The delegable PROJECT_MANAGE bit no longer stands in for org-wide reach:
    // a "Project Manager" work role must not administer every project's teams.
    getAuthContext.mockResolvedValue(ctx({ orgRole: OrgRole.ADMIN }));
    const res = await POST(postReq({ name: "Alpha" }), { params });
    expect(res.status).toBe(201);
    expect(prisma.team.create).toHaveBeenCalled();
  });

  it("allows a project MANAGER who is not an org admin", async () => {
    prisma.projectMember.findFirst.mockResolvedValue({ id: "pm1", role: ProjectRole.MANAGER });
    getAuthContext.mockResolvedValue(ctx());
    const res = await POST(postReq({ name: "Alpha" }), { params });
    expect(res.status).toBe(201);
  });
});

describe("POST teams — validation", () => {
  beforeEach(() => {
    getAuthContext.mockResolvedValue(
      ctx({ orgRole: OrgRole.ADMIN }),
    );
  });

  it("rejects an empty name", async () => {
    const res = await POST(postReq({ name: "   " }), { params });
    expect(res.status).toBe(400);
    expect(prisma.team.create).not.toHaveBeenCalled();
  });

  it("409s on a duplicate name in the same project", async () => {
    // There is a unique index on (projectId, name); surface it as a conflict
    // rather than letting Prisma throw a 500.
    prisma.team.findFirst.mockResolvedValue({ id: "existing" });
    const res = await POST(postReq({ name: "Alpha" }), { params });
    expect(res.status).toBe(409);
    expect(prisma.team.create).not.toHaveBeenCalled();
  });

  it("404s for a project in another org", async () => {
    prisma.project.findFirst.mockResolvedValue(null);
    const res = await POST(postReq({ name: "Alpha" }), { params });
    expect(res.status).toBe(404);
  });
});
