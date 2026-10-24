// @vitest-environment node
//
// canManageProject is called directly by ~17 routes (project members, teams,
// board config, comment moderation) and by its set form for the Issues view.
// An API key reaches its role-based path only when its scopes would grant the
// bit themselves; a browser session is unaffected.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole, ProjectRole } from "@prisma/client";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    orgMember: { findUnique: vi.fn() },
    projectMember: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { canManageProject, getManagedProjectIds } from "./scope";

const P = "22222222-2222-4222-8222-222222222222";
const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: "u1", orgId: "o1", orgRole: OrgRole.ADMIN,
  permissions: Permission.PROJECT_READ, basePermissions: Permission.PROJECT_READ, abacRules: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
  prisma.projectMember.findFirst.mockResolvedValue({ id: "pm1", role: ProjectRole.MANAGER });
  prisma.projectMember.findMany.mockResolvedValue([{ projectId: P }]);
});

describe("canManageProject and API keys", () => {
  it("an ADMIN's read key does not manage the project", async () => {
    expect(await canManageProject(ctx({ isApiKey: true, scopes: ["read"] }), P)).toBe(false);
    expect(await getManagedProjectIds(ctx({ isApiKey: true, scopes: ["read"] }), [P])).toEqual(new Set());
  });

  it("a MANAGER's read key does not either", async () => {
    const c = ctx({ orgRole: OrgRole.MEMBER, isApiKey: true, scopes: ["read"] });
    expect(await canManageProject(c, P)).toBe(false);
    expect(await getManagedProjectIds(c, [P])).toEqual(new Set());
  });

  it("an ADMIN's or MANAGER's write key keeps managing", async () => {
    expect(await canManageProject(ctx({ isApiKey: true, scopes: ["items:write"] }), P)).toBe(true);
    const m = ctx({ orgRole: OrgRole.MEMBER, isApiKey: true, scopes: ["items:write"] });
    expect(await canManageProject(m, P)).toBe(true);
    expect(await getManagedProjectIds(m, [P])).toEqual(new Set([P]));
  });

  it("a browser session is unchanged", async () => {
    expect(await canManageProject(ctx(), P)).toBe(true);
    expect(await getManagedProjectIds(ctx(), [P])).toEqual(new Set([P]));
  });
});
