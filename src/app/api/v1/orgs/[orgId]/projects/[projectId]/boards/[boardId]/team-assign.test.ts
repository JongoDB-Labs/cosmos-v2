// @vitest-environment node
//
// Assigning a board to a team. Without this the Board.teamId column would exist
// with no way to set it — the exact shape of the earlier teamScopedAccess
// mistake, where the mechanism shipped and the means did not.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission } from "@/lib/rbac/permissions";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  logAudit: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findFirst: vi.fn() },
    board: { findFirst: vi.fn(), update: vi.fn() },
    team: { findFirst: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { PUT } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJ = "22222222-2222-4222-8222-222222222222";
const BOARD = "33333333-3333-4333-8333-333333333333";
const TEAM = "44444444-4444-4444-8444-444444444444";

const params = Promise.resolve({ orgId: ORG, projectId: PROJ, boardId: BOARD });
const req = (body: unknown) =>
  new NextRequest("http://localhost/x", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  const perms = Permission.BOARD_UPDATE | Permission.PROJECT_MANAGE;
  getAuthContext.mockResolvedValue({
    userId: "55555555-5555-4555-8555-555555555555",
    orgId: ORG,
    orgRole: OrgRole.ADMIN,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  });
  prisma.organization.findUnique.mockResolvedValue({ id: ORG, slug: "acme" });
  prisma.project.findFirst.mockResolvedValue({ id: PROJ, orgId: ORG, teamScopedAccess: false });
  prisma.board.findFirst.mockResolvedValue({ id: BOARD, projectId: PROJ, orgId: ORG });
  prisma.team.findFirst.mockResolvedValue({ id: TEAM });
  prisma.board.update.mockResolvedValue({ id: BOARD, columns: [] });
  prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
  prisma.projectMember.findFirst.mockResolvedValue(null);
});

describe("PUT board — team assignment", () => {
  it("assigns the board to a team in this project", async () => {
    const res = await PUT(req({ teamId: TEAM }), { params });
    expect(res.status).toBe(200);
    expect(prisma.board.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ teamId: TEAM }) }),
    );
  });

  it("shares it back with the project when given null", async () => {
    // Distinct from omitting the field, which means "leave as-is". Without an
    // explicit null there would be no way to undo an assignment.
    const res = await PUT(req({ teamId: null }), { params });
    expect(res.status).toBe(200);
    expect(prisma.board.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ teamId: null }) }),
    );
  });

  it("rejects a team from another project", async () => {
    // The FK proves the team exists, not that it belongs here. Accepting one
    // would hide the board from everybody on this project.
    prisma.team.findFirst.mockResolvedValue(null);
    const res = await PUT(req({ teamId: TEAM }), { params });
    expect(res.status).toBe(400);
    expect(prisma.board.update).not.toHaveBeenCalled();
  });

  it("leaves teamId alone when the field is absent", async () => {
    const res = await PUT(req({ name: "Renamed" }), { params });
    expect(res.status).toBe(200);
    const arg = prisma.board.update.mock.calls[0][0];
    expect("teamId" in arg.data).toBe(false);
  });
});
