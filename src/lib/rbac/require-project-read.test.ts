// @vitest-environment node
//
// The gate every project-scoped read route calls.
//
// The audit found 46 routes under projects/[projectId] gating reads on the raw
// org-wide bitmask, so team-scoped access held on the Issues list and nowhere
// else. This is the conversion target.
//
// TWO PROPERTIES IT MUST NOT BREAK, both easy to get wrong:
//
//   1. It must NOT impose PROJECT_READ. Routes gate on their own action bit,
//      and GUEST holds ITEM_READ *without* PROJECT_READ (permissions.ts:321).
//      Folding canReadProject in wholesale would silently revoke GUEST access
//      to items on every unrestricted project — a change nobody asked for,
//      dressed as a security fix.
//   2. On a project that has not opted into teamScopedAccess it must behave
//      exactly like the requirePermission call it replaces.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";
import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    project: { findFirst: vi.fn(), findMany: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { requireProjectRead } from "./require-project-read";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";

function ctx(over: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "33333333-3333-3333-3333-333333333333",
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions: Permission.ITEM_READ,
    basePermissions: Permission.ITEM_READ,
    abacRules: [],
    ...over,
  };
}

function project(teamScopedAccess: boolean) {
  prisma.project.findFirst.mockResolvedValue({ id: PROJECT_ID, orgId: ORG_ID, teamScopedAccess });
}
const inProject = () => {
  prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
  prisma.projectMember.findFirst.mockResolvedValue({ id: "pm1" });
};
const notInProject = () => {
  prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
  prisma.projectMember.findFirst.mockResolvedValue(null);
};

beforeEach(() => vi.clearAllMocks());

describe("requireProjectRead — unrestricted projects behave as before", () => {
  it("allows a non-member holding the action bit", async () => {
    project(false);
    notInProject();
    await expect(requireProjectRead(ctx(), PROJECT_ID, "ITEM_READ")).resolves.toBeUndefined();
  });

  it("does NOT require PROJECT_READ — a GUEST with only ITEM_READ still reads items", async () => {
    // GUEST is granted ITEM_READ and not PROJECT_READ. Requiring project-read
    // here would revoke that everywhere, which is not this change's business.
    project(false);
    notInProject();
    const guest = ctx({
      orgRole: OrgRole.GUEST,
      permissions: Permission.ITEM_READ,
      basePermissions: Permission.ITEM_READ,
    });
    await expect(requireProjectRead(guest, PROJECT_ID, "ITEM_READ")).resolves.toBeUndefined();
  });

  it("still refuses an actor lacking the action bit", async () => {
    project(false);
    inProject();
    await expect(
      requireProjectRead(ctx({ permissions: 0n, basePermissions: 0n }), PROJECT_ID, "ITEM_READ"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("requireProjectRead — team-scoped projects", () => {
  it("refuses a non-member even though they hold the action bit", async () => {
    project(true);
    notInProject();
    await expect(
      requireProjectRead(ctx(), PROJECT_ID, "ITEM_READ"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("allows a project member", async () => {
    project(true);
    inProject();
    await expect(requireProjectRead(ctx(), PROJECT_ID, "ITEM_READ")).resolves.toBeUndefined();
  });

  it("allows the org OWNER (break-glass)", async () => {
    project(true);
    notInProject();
    await expect(
      requireProjectRead(ctx({ orgRole: OrgRole.OWNER }), PROJECT_ID, "ITEM_READ"),
    ).resolves.toBeUndefined();
  });

  it("allows an org ADMIN (org-wide administration breaks glass)", async () => {
    project(true);
    notInProject();
    await expect(
      requireProjectRead(ctx({ orgRole: OrgRole.ADMIN }), PROJECT_ID, "ITEM_READ"),
    ).resolves.toBeUndefined();
  });

  it("REFUSES a plain member carrying a delegated PROJECT_MANAGE grant", async () => {
    // Reported from the running app. PROJECT_MANAGE is handed to ordinary
    // members by a work role so they can run their own project; treating it as
    // org-wide reach let a "Project Manager" read every restricted project in
    // the org. Break-glass follows the org ROLE, which a work role cannot grant.
    project(true);
    notInProject();
    await expect(
      requireProjectRead(
        ctx({
          orgRole: OrgRole.MEMBER,
          permissions: Permission.ITEM_READ | Permission.PROJECT_MANAGE,
        }),
        PROJECT_ID,
        "ITEM_READ",
      ),
    ).rejects.toThrow();
  });
});

describe("requireProjectRead — safety", () => {
  it("refuses a project that is not in this org", async () => {
    prisma.project.findFirst.mockResolvedValue(null);
    inProject();
    await expect(
      requireProjectRead(ctx(), PROJECT_ID, "ITEM_READ"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("honours an ABAC deny for the action", async () => {
    project(false);
    inProject();
    const denied = ctx({
      abacRules: [{ effect: "deny", actions: ["ITEM_READ"], conditions: [{ rel: "in_project" }] }],
    });
    await expect(
      requireProjectRead(denied, PROJECT_ID, "ITEM_READ"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
