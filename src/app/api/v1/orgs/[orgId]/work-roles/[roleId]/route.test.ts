// @vitest-environment node
//
// RBAC privilege-escalation regression lock for work-role EDITING (PUT
// .../work-roles/[roleId]). Mock ONLY the I/O boundaries; leave the
// authoring-ceiling check (`permissionMaskFromKeys` + `isPermissionSubset`,
// unmocked) running against a crafted AuthContext.
//
// Locks the fixes in route.ts:
//   - editing grants beyond your own basePermissions → 403 (lines 65-77)
//   - editing an isBuiltIn:true role → 403 (lines 54-60)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

// --- I/O boundary mocks ------------------------------------------------------
const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    workRole: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { PUT, DELETE } from "./route";

// --- ctx + fixture helpers ---------------------------------------------------
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ROLE_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(opts: { basePermissions: bigint; orgRole?: OrgRole }): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: opts.orgRole ?? OrgRole.ADMIN,
    permissions: opts.basePermissions | Permission.ORG_MANAGE_MEMBERS,
    basePermissions: opts.basePermissions,
    abacRules: [],
  };
}

function putRequest(
  grants: PermissionKey[] | undefined,
  overrides: Record<string, unknown> = {},
): NextRequest {
  const body: Record<string, unknown> = { ...overrides };
  if (grants !== undefined) body.grants = grants;
  return new NextRequest(`http://localhost/api/v1/orgs/o/work-roles/r`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function deleteRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/o/work-roles/r`, {
    method: "DELETE",
  });
}

const params = Promise.resolve({ orgId: ORG_ID, roleId: ROLE_ID });

/** The existing role row read via workRole.findFirst (twice: the guard read and
 *  the post-update reload). Default mock returns this for every call. */
function mockExistingRole(opts: { isBuiltIn: boolean }) {
  prisma.workRole.findFirst.mockResolvedValue({
    id: ROLE_ID,
    orgId: ORG_ID,
    key: "auditor",
    name: "Auditor",
    description: null,
    grants: 0n,
    policies: [],
    isBuiltIn: opts.isBuiltIn,
    createdAt: new Date(),
    updatedAt: new Date(),
    _count: { members: 0 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.workRole.update.mockResolvedValue({ id: ROLE_ID });
  prisma.workRole.delete.mockResolvedValue({ id: ROLE_ID });
  logAudit.mockResolvedValue(undefined);
});

describe("PUT /work-roles/[roleId] — authoring ceiling + built-in immutability", () => {
  it("editing grants beyond basePermissions → 403, no update", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ basePermissions: bits("ORG_READ", "AUDIT_LOG_READ") }),
    );
    mockExistingRole({ isBuiltIn: false });

    const res = await PUT(putRequest(["ORG_MANAGE_BILLING"]), { params });

    expect(res.status).toBe(403);
    expect(prisma.workRole.update).not.toHaveBeenCalled();
  });

  it("editing grants within basePermissions → succeeds (200)", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ basePermissions: bits("ORG_READ", "AUDIT_LOG_READ", "FINANCE_READ") }),
    );
    mockExistingRole({ isBuiltIn: false });

    const res = await PUT(putRequest(["AUDIT_LOG_READ", "FINANCE_READ"]), { params });

    expect(res.status).toBe(200);
    expect(prisma.workRole.update).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "work_role.updated", entityId: ROLE_ID }),
    );
  });

  it("editing an isBuiltIn:true role → 403, no update (even within ceiling)", async () => {
    // Actor's base trivially covers the grant — failure must come from the
    // built-in immutability guard, which runs BEFORE the ceiling check.
    getAuthContext.mockResolvedValue(
      ctxWith({ basePermissions: bits("ORG_READ", "AUDIT_LOG_READ") }),
    );
    mockExistingRole({ isBuiltIn: true });

    const res = await PUT(putRequest(["AUDIT_LOG_READ"]), { params });

    expect(res.status).toBe(403);
    expect(prisma.workRole.update).not.toHaveBeenCalled();
  });
});

// Guardrails around role EDITING: built-ins are read-only end to end (PUT and
// DELETE, with the exact error body the settings UI matches on), and renaming
// a custom role can't collide with another role's name case-insensitively —
// the same 409 contract POST enforces on create.
describe("PUT/DELETE /work-roles/[roleId] — built-in read-only contract + rename uniqueness", () => {
  const BUILTIN_ANALYST_ROLE = {
    id: ROLE_ID,
    orgId: ORG_ID,
    key: "builtin.analyst",
    name: "Analyst",
    description: "See everything, change nothing.",
    grants: 0n,
    policies: [],
    isBuiltIn: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    _count: { members: 0 },
  };

  it("PUT renaming a seeded built-in (builtin.analyst) → 403 read-only, no update", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ basePermissions: bits("ORG_READ", "AUDIT_LOG_READ") }),
    );
    prisma.workRole.findFirst.mockResolvedValue(BUILTIN_ANALYST_ROLE);

    const res = await PUT(putRequest(undefined, { name: "Analyst But Evil" }), { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "built-in roles are read-only" });
    expect(prisma.workRole.update).not.toHaveBeenCalled();
  });

  it("DELETE on a seeded built-in (builtin.analyst) → 403 read-only, no delete", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ basePermissions: bits("ORG_READ", "AUDIT_LOG_READ") }),
    );
    prisma.workRole.findFirst.mockResolvedValue(BUILTIN_ANALYST_ROLE);

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "built-in roles are read-only" });
    expect(prisma.workRole.delete).not.toHaveBeenCalled();
  });

  it("PUT renaming a custom role to collide case-insensitively with another role's name → 409, no update", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ basePermissions: bits("ORG_READ", "AUDIT_LOG_READ") }),
    );
    prisma.workRole.findFirst
      // 1st call: fetch the role being edited (non-built-in, passes the guard).
      .mockResolvedValueOnce({
        id: ROLE_ID,
        orgId: ORG_ID,
        key: "auditor",
        name: "Auditor",
        description: null,
        grants: 0n,
        policies: [],
        isBuiltIn: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { members: 0 },
      })
      // 2nd call: the rename-uniqueness check finds another role already
      // named "Casing Test".
      .mockResolvedValueOnce({ id: "99999999-9999-9999-9999-999999999999" });

    const res = await PUT(putRequest(undefined, { name: "casing test" }), { params });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "a role with this name already exists" });
    expect(prisma.workRole.update).not.toHaveBeenCalled();
  });
});
