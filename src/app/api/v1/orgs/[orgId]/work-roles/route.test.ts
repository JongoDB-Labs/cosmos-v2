// @vitest-environment node
//
// RBAC privilege-escalation regression lock for work-role AUTHORING (POST
// .../work-roles). Mock ONLY the I/O boundaries; leave the authoring-ceiling
// check (`permissionMaskFromKeys` + `isPermissionSubset`, both unmocked) running
// against a crafted AuthContext.
//
// Locks the fix in route.ts (lines 56-64): you can't CREATE a role whose grant
// keys exceed your own `basePermissions`. Ceiling is basePermissions (NOT
// permissions) so a self-assigned work-role grant can't be laundered.
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
    workRole: { create: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { POST } from "./route";

// --- ctx + fixture helpers ---------------------------------------------------
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ROLE_ID = "33333333-3333-3333-3333-333333333333";
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

function postRequest(grants: PermissionKey[]): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/o/work-roles`, {
    method: "POST",
    body: JSON.stringify({ key: "auditor", name: "Auditor", grants }),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ orgId: ORG_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.workRole.create.mockResolvedValue({
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
  });
  logAudit.mockResolvedValue(undefined);
});

describe("POST /work-roles — authoring ceiling (isPermissionSubset)", () => {
  it("creating a role whose grants exceed basePermissions → 403, no create", async () => {
    // Actor's base lacks ORG_MANAGE_BILLING but the new role would grant it.
    getAuthContext.mockResolvedValue(
      ctxWith({ basePermissions: bits("ORG_READ", "AUDIT_LOG_READ") }),
    );

    const res = await POST(postRequest(["ORG_MANAGE_BILLING", "AUDIT_LOG_READ"]), { params });

    expect(res.status).toBe(403);
    expect(prisma.workRole.create).not.toHaveBeenCalled();
  });

  it("creating a role whose grants are within basePermissions → succeeds (201)", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ basePermissions: bits("ORG_READ", "AUDIT_LOG_READ", "FINANCE_READ") }),
    );

    const res = await POST(postRequest(["AUDIT_LOG_READ", "FINANCE_READ"]), { params });

    expect(res.status).toBe(201);
    expect(prisma.workRole.create).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "work_role.created" }),
    );
  });
});
