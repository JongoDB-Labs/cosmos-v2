// @vitest-environment node
//
// REPRODUCES A REPORTED PRODUCTION LEAK.
//
// An org MEMBER with no permission overrides, not a member of a project whose
// team_scoped_access was true, could still see that project on 2.249.7 — after
// the page layout had been gated.
//
// The layout fix (#520) was correct but incomplete. `getReadableProjectIds`
// here is what the ORG-WIDE surfaces use — the Issues list, its facets, the
// activity feed, export — and it folds in ABAC `in_project` denies while
// knowing nothing about teamScopedAccess. With no ABAC policies authored (the
// normal case) it returns EVERY project, so a restricted project's work items,
// name and key still came back on those screens.
//
// Two similarly-named helpers, and only the newer one understood the new flag.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    project: { findMany: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { getReadableProjectIds } from "./scope";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OPEN = "22222222-2222-4222-8222-222222222222";
const RESTRICTED = "33333333-3333-4333-8333-333333333333";

function ctx(over: Partial<AuthContext> = {}): AuthContext {
  const perms = Permission.ITEM_READ | Permission.PROJECT_READ;
  return {
    userId: "44444444-4444-4444-8444-444444444444",
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.project.findMany.mockResolvedValue([
    { id: OPEN, teamScopedAccess: false },
    { id: RESTRICTED, teamScopedAccess: true },
  ]);
  prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
  prisma.projectMember.findMany.mockResolvedValue([]); // a member of nothing
});

describe("getReadableProjectIds — teamScopedAccess", () => {
  it("excludes a restricted project the actor is not a member of", async () => {
    // The reported bug, exactly: MEMBER, no overrides, not on the project.
    const ids = await getReadableProjectIds(ctx());
    expect(ids).toContain(OPEN);
    expect(ids).not.toContain(RESTRICTED);
  });

  it("includes it for a member of that project", async () => {
    prisma.projectMember.findMany.mockResolvedValue([{ projectId: RESTRICTED }]);
    const ids = await getReadableProjectIds(ctx());
    expect(ids).toEqual(expect.arrayContaining([OPEN, RESTRICTED]));
  });

  it("includes it for the org OWNER — break-glass, unchanged", async () => {
    const ids = await getReadableProjectIds(ctx({ orgRole: OrgRole.OWNER }));
    expect(ids).toContain(RESTRICTED);
  });

  it("includes it for a PROJECT_MANAGE holder — admins keep access", async () => {
    const ids = await getReadableProjectIds(
      ctx({ permissions: Permission.ITEM_READ | Permission.PROJECT_MANAGE }),
    );
    expect(ids).toContain(RESTRICTED);
  });

  it("leaves an org with nothing restricted completely unchanged", async () => {
    prisma.project.findMany.mockResolvedValue([{ id: OPEN, teamScopedAccess: false }]);
    const ids = await getReadableProjectIds(ctx());
    expect(ids).toEqual([OPEN]);
  });
});

describe("getReadableProjectIds — the ABAC behaviour it already had", () => {
  it("still honours an in_project ITEM_READ deny", async () => {
    prisma.project.findMany.mockResolvedValue([{ id: OPEN, teamScopedAccess: false }]);
    prisma.projectMember.findMany.mockResolvedValue([{ projectId: OPEN }]);
    const denied = ctx({
      abacRules: [{ effect: "deny", actions: ["ITEM_READ"], conditions: [{ rel: "in_project" }] }],
    });
    expect(await getReadableProjectIds(denied)).not.toContain(OPEN);
  });
});
