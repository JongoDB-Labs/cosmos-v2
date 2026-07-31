// @vitest-environment node
//
// Someone made MANAGER of a project could not run it. ~44 mutating routes under
// projects/[projectId] gated on an org-wide bit alone — usually PROJECT_UPDATE,
// which an ordinary member does not hold — so a project manager could not add a
// milestone, a risk, a sprint or a deliverable to their own project. The only
// way to make them effective was to widen their ORG role, which then handed them
// every other project too.
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

import { requireProjectManage, canAdministerProject } from "./require-project-manage";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function ctx(over: Partial<AuthContext> = {}): AuthContext {
  const perms = Permission.PROJECT_READ | Permission.ITEM_READ;
  return {
    userId: "33333333-3333-4333-8333-333333333333",
    orgId: "11111111-1111-4111-8111-111111111111",
    orgRole: OrgRole.MEMBER,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
    ...over,
  };
}

/** Is the actor a MANAGER of this project? */
function asProjectManager(yes: boolean) {
  prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
  prisma.projectMember.findFirst.mockResolvedValue(yes ? { id: "pm1", role: ProjectRole.MANAGER } : null);
}

beforeEach(() => vi.clearAllMocks());

describe("requireProjectManage", () => {
  it("allows a MANAGER of this project who holds no org-wide bit", async () => {
    // The reported gap, exactly.
    asProjectManager(true);
    await expect(requireProjectManage(ctx(), PROJECT_ID)).resolves.toBeUndefined();
  });

  it("refuses a project member who is NOT its manager", async () => {
    asProjectManager(false);
    await expect(requireProjectManage(ctx(), PROJECT_ID)).rejects.toThrow();
  });

  it("REFUSES a delegated PROJECT_MANAGE grant on a project it does not manage", async () => {
    // The bit is what a "Project Manager" work role hands to an ordinary member.
    // If canManageProject treats it as org-wide authority, granting someone ONE
    // project silently grants them EVERY project — the write-side twin of the
    // visibility bug. Nothing else in the suite pins this down: reverting that
    // rule killed no test until this one existed.
    asProjectManager(false);
    await expect(
      requireProjectManage(
        ctx({ orgRole: OrgRole.MEMBER, permissions: Permission.PROJECT_MANAGE }),
        PROJECT_ID,
      ),
    ).rejects.toThrow();
  });

  it("still allows an org-wide PROJECT_UPDATE holder — nobody loses anything", async () => {
    // Whoever could do this before still can, without a membership lookup.
    asProjectManager(false);
    await expect(
      requireProjectManage(ctx({ permissions: Permission.PROJECT_UPDATE }), PROJECT_ID),
    ).resolves.toBeUndefined();
    expect(prisma.projectMember.findFirst).not.toHaveBeenCalled();
  });

  it("allows an org ADMIN who is not on the project at all", async () => {
    asProjectManager(false);
    await expect(
      requireProjectManage(ctx({ orgRole: OrgRole.ADMIN }), PROJECT_ID),
    ).resolves.toBeUndefined();
  });

  it("honours a caller that requires a DIFFERENT org bit", async () => {
    // Routes gate on their own action bit (SPRINT_CREATE, OKR_UPDATE, …), so the
    // org-wide door must be the one the route actually asked for — not a blanket
    // PROJECT_UPDATE that would widen every one of them.
    asProjectManager(false);
    await expect(
      requireProjectManage(
        ctx({ permissions: Permission.SPRINT_CREATE }),
        PROJECT_ID,
        Permission.SPRINT_CREATE,
      ),
    ).resolves.toBeUndefined();

    asProjectManager(false);
    await expect(
      requireProjectManage(
        ctx({ permissions: Permission.PROJECT_UPDATE }),
        PROJECT_ID,
        Permission.SPRINT_CREATE,
      ),
    ).rejects.toThrow();
  });

  it("lets a project MANAGER through whatever org bit the route named", async () => {
    // The manager path must not depend on which bit the route chose, or a
    // manager would be able to add a risk but not a sprint.
    asProjectManager(true);
    await expect(
      requireProjectManage(ctx(), PROJECT_ID, Permission.SPRINT_CREATE),
    ).resolves.toBeUndefined();
  });
});

describe("canAdministerProject — the boolean form the UI renders from", () => {
  it("agrees with requireProjectManage for a project MANAGER", async () => {
    asProjectManager(true);
    expect(await canAdministerProject(ctx(), PROJECT_ID)).toBe(true);
  });

  it("agrees for someone with neither route in", async () => {
    // If these two ever disagree the UI offers a button that 403s.
    asProjectManager(false);
    expect(await canAdministerProject(ctx(), PROJECT_ID)).toBe(false);
  });
});
