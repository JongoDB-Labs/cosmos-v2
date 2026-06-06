// @vitest-environment node
//
// RBAC privilege-escalation regression lock for the work-role MEMBER ASSIGNMENT
// handler (PUT .../work-roles/[roleId]/members). Mock ONLY the I/O boundaries;
// leave the ceiling check (`isPermissionSubset`, unmocked) running against a
// crafted AuthContext.
//
// Locks the fix in route.ts (lines 49-63): a caller can't ASSIGN a work-role
// whose `grants` include a bit they don't hold in `basePermissions`. The ceiling
// is basePermissions (NOT permissions) so a self-assigned grant can't be
// re-laundered.
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
    workRole: { findFirst: vi.fn() },
    orgMember: { findMany: vi.fn() },
    orgMemberWorkRole: { deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(),
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
// Must be a schema-valid UUID (route validates orgMemberIds with z.string().uuid()):
// version nibble 4, variant nibble 8/9/a/b.
const ASSIGNEE_ID = "66666666-6666-4666-8666-666666666666";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(opts: { basePermissions: bigint; orgRole?: OrgRole }): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: opts.orgRole ?? OrgRole.ADMIN,
    // `permissions` carries the gate bit (ORG_MANAGE_MEMBERS) so requirePermission
    // passes; the ceiling check reads `basePermissions` specifically.
    permissions: opts.basePermissions | Permission.ORG_MANAGE_MEMBERS,
    basePermissions: opts.basePermissions,
    abacRules: [],
  };
}

function putRequest(orgMemberIds: string[]): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/o/work-roles/r/members`, {
    method: "PUT",
    body: JSON.stringify({ orgMemberIds }),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ orgId: ORG_ID, roleId: ROLE_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  // Member validation: the assignee is a genuine member of THIS org.
  prisma.orgMember.findMany.mockResolvedValue([{ id: ASSIGNEE_ID }]);
  prisma.$transaction.mockResolvedValue([{ count: 1 }, { count: 1 }]);
  logAudit.mockResolvedValue(undefined);
});

describe("PUT /work-roles/[roleId]/members — assignment ceiling (isPermissionSubset)", () => {
  it("non-OWNER whose basePermissions LACKS a grant bit cannot assign that role → 403", async () => {
    // The role grants ORG_MANAGE_BILLING; the ADMIN actor's base lacks it.
    getAuthContext.mockResolvedValue(
      ctxWith({ basePermissions: bits("ORG_READ", "PROJECT_READ") }),
    );
    prisma.workRole.findFirst.mockResolvedValue({
      id: ROLE_ID,
      grants: bits("ORG_MANAGE_BILLING"),
    });

    const res = await PUT(putRequest([ASSIGNEE_ID]), { params });

    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("basePermissions covering every grant bit → assignment succeeds (200)", async () => {
    // Actor's base now holds ORG_MANAGE_BILLING, so the role is within ceiling.
    getAuthContext.mockResolvedValue(
      ctxWith({ basePermissions: bits("ORG_READ", "ORG_MANAGE_BILLING") }),
    );
    prisma.workRole.findFirst.mockResolvedValue({
      id: ROLE_ID,
      grants: bits("ORG_MANAGE_BILLING"),
    });

    const res = await PUT(putRequest([ASSIGNEE_ID]), { params });

    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "work_role.members_set", entityId: ROLE_ID }),
    );
  });
});
