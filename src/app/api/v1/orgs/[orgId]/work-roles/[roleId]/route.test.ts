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
    workRole: { findFirst: vi.fn(), update: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { PUT } from "./route";

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

function putRequest(grants: PermissionKey[]): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/o/work-roles/r`, {
    method: "PUT",
    body: JSON.stringify({ grants }),
    headers: { "Content-Type": "application/json" },
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
