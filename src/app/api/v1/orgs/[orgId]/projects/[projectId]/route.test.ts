// @vitest-environment node
//
// FR "Default view" (COSMOS-7): a manager/owner/admin sets the PROJECT-WIDE
// default view by PUTting `{ settings: { defaultTab } }`, which merges into
// Project.settings (persisted, shared). This test pins the write contract the
// UI depends on:
//   - the elevated-role GATE (org PROJECT_UPDATE OR project MANAGER), so a plain
//     member cannot change what everyone else lands on;
//   - the settings MERGE, so setting the default doesn't clobber other settings.
//
// The authz helpers (hasPermission / canManageProject) run FOR REAL against a
// crafted AuthContext + mocked prisma — that decision is the whole point.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole, ProjectRole } from "@prisma/client";

const { getAuthContext, prisma, logAudit, revalidateOrgProjects } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findFirst: vi.fn(), update: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { findFirst: vi.fn() },
  },
  logAudit: vi.fn(),
  revalidateOrgProjects: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/cache/queries", () => ({ revalidateOrgProjects }));

import { PUT } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR_ID = "33333333-3333-3333-3333-333333333333";
const ORG_MEMBER_ID = "44444444-4444-4444-4444-444444444444";
const BOARD_ID = "55555555-5555-5555-5555-555555555555";

function ctxWith(permissions: bigint): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

function putRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/v1/orgs/o/projects/p", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  // Existing project already carries an unrelated setting — the merge must keep it.
  prisma.project.findFirst.mockResolvedValue({
    id: PROJECT_ID,
    orgId: ORG_ID,
    settings: { hiddenFeatureTabs: ["kpi"] },
  });
  prisma.project.update.mockResolvedValue({
    id: PROJECT_ID,
    _count: { boards: 1, cycles: 0, members: 1 },
  });
  // canManageProject resolves the actor's OrgMember, then looks for a MANAGER
  // ProjectMember row. Default: they are NOT a project manager.
  prisma.orgMember.findUnique.mockResolvedValue({ id: ORG_MEMBER_ID });
  prisma.projectMember.findFirst.mockResolvedValue(null);
  logAudit.mockResolvedValue(undefined);
});

describe("PUT /projects/[projectId] — set project-wide default view (COSMOS-7)", () => {
  it("a plain member (no PROJECT_UPDATE, not a manager) is forbidden and never writes", async () => {
    getAuthContext.mockResolvedValue(ctxWith(Permission.PROJECT_READ));

    const res = await PUT(putRequest({ settings: { defaultTab: `board:${BOARD_ID}` } }), {
      params,
    });

    expect(res.status).toBe(403);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it("an org PROJECT_UPDATE holder sets the default, merged into existing settings", async () => {
    getAuthContext.mockResolvedValue(ctxWith(Permission.PROJECT_UPDATE));

    const res = await PUT(putRequest({ settings: { defaultTab: `board:${BOARD_ID}` } }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PROJECT_ID },
        data: expect.objectContaining({
          // existing key preserved + new default merged in (no clobber).
          settings: { hiddenFeatureTabs: ["kpi"], defaultTab: `board:${BOARD_ID}` },
        }),
      }),
    );
    expect(revalidateOrgProjects).toHaveBeenCalledWith(ORG_ID);
  });

  it("a project MANAGER without any org-wide grant may also set the default", async () => {
    getAuthContext.mockResolvedValue(ctxWith(0n));
    // This actor IS a MANAGER of this project.
    prisma.projectMember.findFirst.mockResolvedValue({ id: "pm-1" });

    const res = await PUT(putRequest({ settings: { defaultTab: "feature:okr" } }), { params });

    expect(res.status).toBe(200);
    expect(prisma.projectMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: PROJECT_ID, role: ProjectRole.MANAGER }),
      }),
    );
    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          settings: { hiddenFeatureTabs: ["kpi"], defaultTab: "feature:okr" },
        }),
      }),
    );
  });
});
