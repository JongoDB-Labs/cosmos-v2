import { describe, expect, it, vi, beforeEach } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { projectMember: { findMany } } }));

import { financeScope, scopeCovers } from "../finance-scope";
import { Permission, RolePermissions } from "../permissions";
import type { AuthContext } from "../check";

const ctx = (permissions: bigint): AuthContext =>
  ({ userId: "u1", orgId: "o1", orgRole: "MEMBER", permissions, basePermissions: permissions, abacRules: [] }) as AuthContext;

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([{ projectId: "p1" }, { projectId: "p2" }]);
});

describe("what a reader may see money for", () => {
  it("gives the whole book to org-wide finance, without a query", async () => {
    expect(await financeScope(ctx(RolePermissions.ADMIN))).toEqual({ kind: "org" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("gives nothing to a role with neither grant, without a query", async () => {
    expect(await financeScope(ctx(RolePermissions.MEMBER))).toEqual({ kind: "none" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("gives the narrow grant exactly its own projects", async () => {
    const s = await financeScope(ctx(Permission.FINANCE_READ_PROJECT | Permission.PROJECT_READ));
    expect(s.kind).toBe("projects");
    expect(scopeCovers(s, "p1")).toBe(true);
    expect(scopeCovers(s, "p9")).toBe(false);
  });

  it("refuses an unknown project under the narrow grant", async () => {
    // Membership cannot be confirmed, and failing to confirm must never read
    // as permission.
    const s = await financeScope(ctx(Permission.FINANCE_READ_PROJECT));
    expect(scopeCovers(s, null)).toBe(false);
    expect(scopeCovers(s, undefined)).toBe(false);
  });

  it("scopes org and none regardless of project", () => {
    expect(scopeCovers({ kind: "org" }, null)).toBe(true);
    expect(scopeCovers({ kind: "none" }, "p1")).toBe(false);
  });

  it("does not let a project member of another org borrow the grant", async () => {
    await financeScope(ctx(Permission.FINANCE_READ_PROJECT));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgMember: { orgId: "o1", userId: "u1" } } }),
    );
  });
});
