// @vitest-environment node
//
// RBAC privilege-escalation regression lock for the org-member PUT handler.
// Pattern mirrors the reference harness at
//   src/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route.test.ts
// — mock ONLY the I/O boundaries (`@/lib/auth/session`, `@/lib/db/client`,
// `@/lib/audit`); leave the authz primitives (`requirePermission`,
// `resolvePermissions`, `hasPermission`) UNMOCKED so the real OWNER-escalation
// guard runs against a crafted AuthContext.
//
// Locks the fix in route.ts where:
//   - a non-OWNER cannot grant `role:"OWNER"` to anyone (lines 48-53)
//   - a non-OWNER cannot change their OWN role (lines 56-61)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

// --- I/O boundary mocks ------------------------------------------------------
const { getAuthContext, prisma, logAudit, publishToOrg } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    orgMember: { findUnique: vi.fn(), update: vi.fn() },
  },
  logAudit: vi.fn(),
  publishToOrg: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));
// Realtime publish is a best-effort side-effect (COSMOS-130); mock it so we can
// assert a member.updated event fires on a successful role change and never on a
// rejected one.
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg }));

import { PUT } from "./route";

// --- ctx + fixture helpers ---------------------------------------------------
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222"; // target member row id
const ACTOR_ID = "44444444-4444-4444-4444-444444444444"; // the caller's userId
const TARGET_USER_ID = "55555555-5555-5555-5555-555555555555"; // target's userId

/** Build a permission bitfield from real Permission bits (no magic numbers). */
function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(opts: {
  permissions: bigint;
  orgRole?: OrgRole;
  userId?: string;
}): AuthContext {
  return {
    userId: opts.userId ?? ACTOR_ID,
    orgId: ORG_ID,
    orgRole: opts.orgRole ?? OrgRole.MEMBER,
    permissions: opts.permissions,
    basePermissions: opts.permissions,
    abacRules: [],
  };
}

/** ORG_MANAGE_MEMBERS is the gate `requirePermission` enforces — every actor
 *  in these tests holds it, so we exercise the OWNER-escalation guard BEYOND it. */
function manageMembers(): bigint {
  return bits("ORG_READ", "ORG_MANAGE_MEMBERS");
}

function putRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/o/members/m`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ orgId: ORG_ID, memberId: MEMBER_ID });

/** Set up the target member row the route reads via orgMember.findUnique. */
function mockTargetMember(opts: { role: OrgRole; userId?: string }) {
  prisma.orgMember.findUnique.mockResolvedValue({
    id: MEMBER_ID,
    orgId: ORG_ID,
    userId: opts.userId ?? TARGET_USER_ID,
    role: opts.role,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // org resolves (so the route reaches the auth/authz stage)
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  // the update, when reached, returns a member-shaped row (permissions excluded)
  prisma.orgMember.update.mockResolvedValue({
    id: MEMBER_ID,
    orgId: ORG_ID,
    userId: TARGET_USER_ID,
    role: OrgRole.ADMIN,
    joinedAt: new Date(),
    user: { id: TARGET_USER_ID, email: "t@x.io", displayName: "T", avatarUrl: null },
  });
  logAudit.mockResolvedValue(undefined);
});

describe("PUT /orgs/[orgId]/members/[memberId] — OWNER-escalation guard", () => {
  it("(a) non-OWNER ADMIN setting role:OWNER on another member → 403, no update", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ permissions: manageMembers(), orgRole: OrgRole.ADMIN }),
    );
    // Target is a different user (so it's not a self-change), currently a MEMBER.
    mockTargetMember({ role: OrgRole.MEMBER });

    const res = await PUT(putRequest({ role: "OWNER" }), { params });

    expect(res.status).toBe(403);
    expect(prisma.orgMember.update).not.toHaveBeenCalled();
    // A rejected change must NOT emit a live-update event.
    expect(publishToOrg).not.toHaveBeenCalled();
  });

  it("(b) non-OWNER changing their OWN role (member.userId === ctx.userId) → 403, no update", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ permissions: manageMembers(), orgRole: OrgRole.ADMIN, userId: ACTOR_ID }),
    );
    // The target member row belongs to the actor themselves; they try MEMBER→ADMIN.
    mockTargetMember({ role: OrgRole.MEMBER, userId: ACTOR_ID });

    const res = await PUT(putRequest({ role: "ADMIN" }), { params });

    expect(res.status).toBe(403);
    expect(prisma.orgMember.update).not.toHaveBeenCalled();
  });

  it("(c) OWNER granting OWNER to another member → succeeds (200)", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({
        // OWNER's permission bitfield holds every bit, incl. ORG_MANAGE_MEMBERS.
        permissions: Permission.ORG_READ | Permission.ORG_MANAGE_MEMBERS,
        orgRole: OrgRole.OWNER,
      }),
    );
    mockTargetMember({ role: OrgRole.MEMBER });

    const res = await PUT(putRequest({ role: "OWNER" }), { params });

    expect(res.status).toBe(200);
    expect(prisma.orgMember.update).toHaveBeenCalledTimes(1);
    expect(prisma.orgMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MEMBER_ID },
        data: { role: "OWNER" },
      }),
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member.role_changed", entityId: MEMBER_ID }),
    );
  });

  it("(d) ADMIN promoting another member MEMBER→ADMIN → succeeds (200)", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ permissions: manageMembers(), orgRole: OrgRole.ADMIN }),
    );
    mockTargetMember({ role: OrgRole.MEMBER });

    const res = await PUT(putRequest({ role: "ADMIN" }), { params });

    expect(res.status).toBe(200);
    expect(prisma.orgMember.update).toHaveBeenCalledTimes(1);
    expect(prisma.orgMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: "ADMIN" } }),
    );
    // A successful role change publishes a member.updated event, org-scoped, so
    // open members/roles views in another tab refresh live (COSMOS-130).
    expect(publishToOrg).toHaveBeenCalledWith(
      ORG_ID,
      "member.updated",
      expect.objectContaining({ orgId: ORG_ID, memberId: MEMBER_ID, role: "ADMIN" }),
    );
  });
});
