// @vitest-environment node
//
// The choke point for project-scoped READ access.
//
// Today (see docs/design/access-control-audit.md) `ProjectMember` is a roster,
// not a boundary: 46 routes under projects/[projectId] gate reads on the raw
// org-wide bitmask, so any org MEMBER reads every project. The driving use case
// — a subcontractor who must see only their own team's work — is unreachable.
//
// This is the single function every project-scoped read goes through, so the
// decision lives in ONE auditable place rather than 46.
//
// THE CRITICAL PROPERTY IS BACKWARD COMPATIBILITY. Flipping every existing org
// from "everyone reads everything" to "members only" overnight would silently
// hide live projects from people who legitimately use them. So narrowing is
// OPT-IN per project (`Project.teamScopedAccess`), and every test below that
// says "unrestricted" is guarding that promise.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    project: { findFirst: vi.fn(), findMany: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { canReadProject } from "./project-access";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR_ID = "33333333-3333-3333-3333-333333333333";
const ORG_MEMBER_ID = "44444444-4444-4444-4444-444444444444";

function ctx(over: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions: Permission.PROJECT_READ | Permission.ITEM_READ,
    basePermissions: Permission.PROJECT_READ | Permission.ITEM_READ,
    abacRules: [],
    ...over,
  };
}

/** The actor is NOT a member of the project. */
function actorNotInProject() {
  prisma.orgMember.findUnique.mockResolvedValue({ id: ORG_MEMBER_ID });
  prisma.projectMember.findFirst.mockResolvedValue(null);
}

/** The actor IS a member of the project. */
function actorInProject() {
  prisma.orgMember.findUnique.mockResolvedValue({ id: ORG_MEMBER_ID });
  prisma.projectMember.findFirst.mockResolvedValue({ id: "pm1" });
}

function project(teamScopedAccess: boolean) {
  prisma.project.findFirst.mockResolvedValue({
    id: PROJECT_ID,
    orgId: ORG_ID,
    teamScopedAccess,
  });
}

beforeEach(() => vi.clearAllMocks());

describe("canReadProject — unrestricted projects (the default, must not regress)", () => {
  it("lets a non-member org MEMBER read an unrestricted project", async () => {
    // This is today's behaviour for every existing project and must survive.
    project(false);
    actorNotInProject();
    expect(await canReadProject(ctx(), PROJECT_ID)).toBe(true);
  });

  it("still refuses an actor with no PROJECT_READ bit", async () => {
    project(false);
    actorInProject();
    expect(await canReadProject(ctx({ permissions: 0n, basePermissions: 0n }), PROJECT_ID)).toBe(false);
  });
});

describe("canReadProject — team-scoped projects (the subcontractor case)", () => {
  it("refuses a non-member, even with the org-wide PROJECT_READ bit", async () => {
    // The whole point: the org bit is no longer sufficient on its own.
    project(true);
    actorNotInProject();
    expect(await canReadProject(ctx(), PROJECT_ID)).toBe(false);
  });

  it("allows a project member", async () => {
    project(true);
    actorInProject();
    expect(await canReadProject(ctx(), PROJECT_ID)).toBe(true);
  });

  it("allows an org ADMIN who is not a project member", async () => {
    // Admin inherit-downward, matching canManageProject. Without this an admin
    // could lock themselves out of a project they are responsible for.
    project(true);
    actorNotInProject();
    expect(
      await canReadProject(
        ctx({ orgRole: OrgRole.ADMIN, permissions: Permission.PROJECT_READ | Permission.PROJECT_MANAGE }),
        PROJECT_ID,
      ),
    ).toBe(true);
  });

  it("allows the org OWNER unconditionally (break-glass, mirrors evaluateAccess)", async () => {
    project(true);
    actorNotInProject();
    expect(await canReadProject(ctx({ orgRole: OrgRole.OWNER }), PROJECT_ID)).toBe(true);
  });
});

describe("canReadProject — safety", () => {
  it("refuses when the project does not exist in this org (no cross-tenant read)", async () => {
    prisma.project.findFirst.mockResolvedValue(null);
    actorInProject();
    expect(await canReadProject(ctx(), PROJECT_ID)).toBe(false);
  });

  it("refuses when the actor is not an org member at all", async () => {
    project(true);
    prisma.orgMember.findUnique.mockResolvedValue(null);
    prisma.projectMember.findFirst.mockResolvedValue(null);
    expect(await canReadProject(ctx(), PROJECT_ID)).toBe(false);
  });
});
