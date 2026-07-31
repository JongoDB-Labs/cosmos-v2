// @vitest-environment node
//
// Project roles beyond MANAGER were decorative: the Members picker offered four
// levels and `ProjectRole` appeared exactly twice in all of src/, both MANAGER.
// A role enum that looks enforced and is not is worse than no enum — someone
// sets a person to VIEWER, believes they cannot edit, and they can.
//
// Chosen semantics (with the live distribution in mind — 14 MEMBER, 6 MANAGER,
// 2 LEAD, 0 VIEWER):
//
//   MANAGER  administer the project and its members        unchanged
//   LEAD     MEMBER plus board management                   grants only
//   MEMBER   defer to the actor's org permissions           unchanged
//   VIEWER   read-only in THIS project                      nobody holds it
//
// So the only restricting rule lands on a role no live row has, and the only
// role that changes for real people can gain but never lose.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole, ProjectRole } from "@prisma/client";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    orgMember: { findUnique: vi.fn() },
    projectMember: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { canWriteInProject, canManageBoardsInProject } from "./project-role";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function ctx(over: Partial<AuthContext> = {}): AuthContext {
  const perms = Permission.ITEM_UPDATE | Permission.PROJECT_READ | Permission.BOARD_CREATE;
  return {
    userId: "33333333-3333-4333-8333-333333333333",
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
    ...over,
  };
}

function asRole(role: ProjectRole | null) {
  prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
  prisma.projectMember.findFirst.mockResolvedValue(role ? { id: "pm1", role } : null);
}

beforeEach(() => vi.clearAllMocks());

describe("canWriteInProject", () => {
  it("refuses a project VIEWER even though their org role permits writing", () => {
    // The whole point: the project role has to beat the org bit, or the label
    // is a lie. Nobody holds VIEWER today, so this restricts no one live.
    asRole(ProjectRole.VIEWER);
    return expect(canWriteInProject(ctx(), PROJECT_ID)).resolves.toBe(false);
  });

  it("allows a project MEMBER — unchanged, defers to org permissions", async () => {
    asRole(ProjectRole.MEMBER);
    expect(await canWriteInProject(ctx(), PROJECT_ID)).toBe(true);
  });

  it("allows LEAD and MANAGER", async () => {
    asRole(ProjectRole.LEAD);
    expect(await canWriteInProject(ctx(), PROJECT_ID)).toBe(true);
    asRole(ProjectRole.MANAGER);
    expect(await canWriteInProject(ctx(), PROJECT_ID)).toBe(true);
  });

  it("allows someone who is not a project member at all — unchanged", async () => {
    // Project roles constrain people ON the project. Whether a non-member may
    // act is the visibility/permission question, decided elsewhere; this must
    // not accidentally become a second membership gate.
    asRole(null);
    expect(await canWriteInProject(ctx(), PROJECT_ID)).toBe(true);
  });

  it("still refuses anyone lacking the org write bit", async () => {
    asRole(ProjectRole.MANAGER);
    expect(await canWriteInProject(ctx({ permissions: 0n, basePermissions: 0n }), PROJECT_ID)).toBe(false);
  });

  it("lets an org admin write even where they are a project VIEWER", async () => {
    // Admin inherit-downward, matching canManageProject and isProjectVisible.
    asRole(ProjectRole.VIEWER);
    const admin = ctx({
      orgRole: OrgRole.ADMIN,
      permissions: Permission.ITEM_UPDATE | Permission.PROJECT_MANAGE,
    });
    expect(await canWriteInProject(admin, PROJECT_ID)).toBe(true);
  });
});

describe("canManageBoardsInProject", () => {
  it("allows LEAD on the strength of the ROLE, with no org board grant", async () => {
    // Deliberately no BOARD_CREATE: with it, this passes through the org-bit
    // fallback whether or not LEAD grants anything, and the test proves nothing.
    // (It did exactly that until a mutation run showed removing LEAD's branch
    // killed no test.)
    asRole(ProjectRole.LEAD);
    const noOrgGrant = ctx({ permissions: Permission.PROJECT_READ, basePermissions: Permission.PROJECT_READ });
    expect(await canManageBoardsInProject(noOrgGrant, PROJECT_ID)).toBe(true);
  });

  it("allows MANAGER on the strength of the ROLE, with no org board grant", async () => {
    asRole(ProjectRole.MANAGER);
    const noOrgGrant = ctx({ permissions: Permission.PROJECT_READ, basePermissions: Permission.PROJECT_READ });
    expect(await canManageBoardsInProject(noOrgGrant, PROJECT_ID)).toBe(true);
  });

  it("falls back to the org bit for a plain MEMBER", async () => {
    // MEMBER is unchanged: whoever could manage boards via org grants still can.
    asRole(ProjectRole.MEMBER);
    expect(await canManageBoardsInProject(ctx(), PROJECT_ID)).toBe(true);
    expect(
      await canManageBoardsInProject(ctx({ permissions: 0n, basePermissions: 0n }), PROJECT_ID),
    ).toBe(false);
  });

  it("refuses a VIEWER with no org grant", async () => {
    asRole(ProjectRole.VIEWER);
    expect(
      await canManageBoardsInProject(ctx({ permissions: 0n, basePermissions: 0n }), PROJECT_ID),
    ).toBe(false);
  });
});
