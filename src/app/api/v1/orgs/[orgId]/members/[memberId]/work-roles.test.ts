// @vitest-environment node
//
// PUT .../members/[memberId]/work-roles — the per-member mirror of
// .../work-roles/[roleId]/members (see that route's PUT for the assignment
// primitive this delta-guards against). Runs against the REAL e2e DB (seeded
// `test-org`, including the 8 seeded built-in work roles — see
// DATABASE_URL in the e2e env); only `getAuthContext` is mocked (session
// cookies aren't available in a route-handler test). Every fixture this file
// creates carries the `t1-uwra` marker and is torn down in `afterAll`; every
// row a single test seeds beyond the shared fixtures is cleaned up in that
// test's own `finally` so a failed assertion never leaves the shared e2e DB
// dirty for the next run.
//
// Proves:
//   - happy add+remove round-trip lands the exact requested set in the DB
//     (and dedupes a repeated id in the request);
//   - an ADDITION whose role grants exceed the caller's basePermissions is
//     rejected 403 (naming the role) with NO write, even though the caller
//     holds ORG_MANAGE_MEMBERS;
//   - a REMOVAL-only request from that same limited caller succeeds — de­
//     escalation is never ceiling-checked;
//   - a roleId from another org 400s as "unknown work role";
//   - a memberId from another org 404s;
//   - a caller lacking ORG_MANAGE_MEMBERS entirely is refused before any of
//     the above logic runs.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";

const { getAuthContext, publishToOrg } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  publishToOrg: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
// Realtime publish is a best-effort side-effect (COSMOS-130); mock it so we can
// assert a member.updated event fires when a member's work-role set changes.
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg }));

import { prisma } from "@/lib/db/client";
import { PUT } from "./work-roles/route";
import { seedBuiltinWorkRoles } from "@/lib/rbac/builtin-work-roles-seed";

const MARKER = "t1-uwra";
const OTHER_ORG_SLUG = `${MARKER}-other-org`;
const TARGET_EMAIL = `${MARKER}-target@test.local`;
const OTHER_MEMBER_EMAIL = `${MARKER}-other-member@test.local`;
// Synthetic actor id for the mocked ctx. AuditLog.userId carries no FK (see
// schema.prisma), so logAudit — left unmocked, running for real — accepts it.
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const ALL_BITS = Object.values(Permission).reduce((acc, p) => acc | p, 0n);

let orgId: string;
let targetUserId: string;
let targetMemberId: string;
let otherOrgId: string;
let otherOrgUserId: string;
let otherOrgMemberId: string;
let otherOrgRoleId: string;
let complianceOfficerRoleId: string;
let complianceOfficerName: string;
let contributorRoleId: string;
let projectManagerRoleId: string;

function ctxWith(opts: { basePermissions: bigint; orgRole?: OrgRole }): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId,
    orgRole: opts.orgRole ?? OrgRole.ADMIN,
    // `permissions` carries the gate bit (ORG_MANAGE_MEMBERS) so requirePermission
    // passes; the ceiling check reads `basePermissions` specifically.
    permissions: opts.basePermissions | Permission.ORG_MANAGE_MEMBERS,
    basePermissions: opts.basePermissions,
    abacRules: [],
  };
}

/** Ceiling never trips — every grant is within basePermissions. */
function ownerCtx(): AuthContext {
  return ctxWith({ basePermissions: ALL_BITS, orgRole: OrgRole.OWNER });
}

/** MEMBER-tier basePermissions — lacks COMPLIANCE_MANAGE/CLASSIFICATION_MANAGE/
 *  AUDIT_LOG_READ, so builtin.compliance-officer's grants exceed it. */
function limitedCtx(): AuthContext {
  return ctxWith({ basePermissions: RolePermissions.MEMBER, orgRole: OrgRole.MEMBER });
}

function paramsFor(memberId: string) {
  return Promise.resolve({ orgId, memberId });
}

function putRequest(memberId: string, workRoleIds: string[]): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/o/members/${memberId}/work-roles`, {
    method: "PUT",
    body: JSON.stringify({ workRoleIds }),
    headers: { "Content-Type": "application/json" },
  });
}

async function purgeFixtures() {
  const staleOrg = await prisma.organization.findFirst({
    where: { slug: OTHER_ORG_SLUG },
    select: { id: true },
  });
  if (staleOrg) await prisma.organization.delete({ where: { id: staleOrg.id } });

  const staleOtherUser = await prisma.user.findFirst({ where: { email: OTHER_MEMBER_EMAIL } });
  if (staleOtherUser) await prisma.user.delete({ where: { id: staleOtherUser.id } });

  const staleTargetUser = await prisma.user.findFirst({ where: { email: TARGET_EMAIL } });
  if (staleTargetUser) await prisma.user.delete({ where: { id: staleTargetUser.id } });
}

beforeAll(async () => {
  await purgeFixtures();

  const org = await prisma.organization.findFirstOrThrow({
    where: { slug: "test-org" },
    select: { id: true },
  });
  orgId = org.id;
  // CI runs on a pristine DB where the catalog may not be seeded yet (file order
  // is nondeterministic) — seed idempotently before the lookups below rely on it.
  await seedBuiltinWorkRoles(orgId);

  const targetUser = await prisma.user.create({
    data: { email: TARGET_EMAIL, displayName: "T1 UWRA Target" },
  });
  targetUserId = targetUser.id;
  const targetMember = await prisma.orgMember.create({
    data: { orgId, userId: targetUserId, role: OrgRole.MEMBER },
  });
  targetMemberId = targetMember.id;

  const otherOrg = await prisma.organization.create({
    data: { name: "T1 UWRA Other Org", slug: OTHER_ORG_SLUG },
  });
  otherOrgId = otherOrg.id;
  const otherUser = await prisma.user.create({
    data: { email: OTHER_MEMBER_EMAIL, displayName: "T1 UWRA Other Member" },
  });
  otherOrgUserId = otherUser.id;
  const otherMember = await prisma.orgMember.create({
    data: { orgId: otherOrgId, userId: otherOrgUserId, role: OrgRole.MEMBER },
  });
  otherOrgMemberId = otherMember.id;
  const otherRole = await prisma.workRole.create({
    data: { orgId: otherOrgId, key: `${MARKER}-foreign-role`, name: "T1 UWRA Foreign Role", grants: "0" },
  });
  otherOrgRoleId = otherRole.id;

  const compliance = await prisma.workRole.findFirstOrThrow({
    where: { orgId, key: "builtin.compliance-officer" },
  });
  complianceOfficerRoleId = compliance.id;
  complianceOfficerName = compliance.name;

  const contributor = await prisma.workRole.findFirstOrThrow({
    where: { orgId, key: "builtin.contributor" },
  });
  contributorRoleId = contributor.id;

  const projectManager = await prisma.workRole.findFirstOrThrow({
    where: { orgId, key: "builtin.project-manager" },
  });
  projectManagerRoleId = projectManager.id;
});

afterAll(async () => {
  // Cascades (onDelete: Cascade, schema.prisma) clean up org_members,
  // work_roles and org_member_work_roles rows scoped to these fixtures.
  await prisma.organization.delete({ where: { id: otherOrgId } });
  await prisma.user.delete({ where: { id: otherOrgUserId } });
  await prisma.user.delete({ where: { id: targetUserId } });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PUT /members/[memberId]/work-roles — delta-guarded set", () => {
  it("happy add+remove round-trip lands the exact requested set (and dedupes)", async () => {
    getAuthContext.mockResolvedValue(ownerCtx());

    // Seed an initial assignment so this call exercises a removal (contributor)
    // alongside an addition (project-manager) in the same request.
    await prisma.orgMemberWorkRole.create({
      data: { orgMemberId: targetMemberId, workRoleId: contributorRoleId },
    });

    try {
      const res = await PUT(
        // Repeated id exercises the in-handler dedupe.
        putRequest(targetMemberId, [projectManagerRoleId, projectManagerRoleId]),
        { params: paramsFor(targetMemberId) },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.workRoleIds).toEqual([projectManagerRoleId]);

      const rows = await prisma.orgMemberWorkRole.findMany({
        where: { orgMemberId: targetMemberId },
        select: { workRoleId: true },
      });
      expect(rows.map((r) => r.workRoleId)).toEqual([projectManagerRoleId]);

      // The set change publishes a member.updated event, org-scoped, so open
      // members/roles views in another tab refresh live (COSMOS-130).
      expect(publishToOrg).toHaveBeenCalledWith(
        orgId,
        "member.updated",
        expect.objectContaining({ orgId, memberId: targetMemberId, workRolesChanged: true }),
      );
    } finally {
      await prisma.orgMemberWorkRole.deleteMany({ where: { orgMemberId: targetMemberId } });
    }
  });

  it("addition exceeding the limited ctx's basePermissions → 403 naming the role, DB unchanged", async () => {
    getAuthContext.mockResolvedValue(limitedCtx());

    try {
      const res = await PUT(
        putRequest(targetMemberId, [complianceOfficerRoleId]),
        { params: paramsFor(targetMemberId) },
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: `You can't grant '${complianceOfficerName}' — it exceeds your own permissions`,
      });

      const rows = await prisma.orgMemberWorkRole.findMany({ where: { orgMemberId: targetMemberId } });
      expect(rows).toHaveLength(0);
    } finally {
      await prisma.orgMemberWorkRole.deleteMany({ where: { orgMemberId: targetMemberId } });
    }
  });

  it("removal-only by the same limited ctx → 200 (de-escalation is never ceiling-checked)", async () => {
    // Pre-seed the over-privileged assignment directly, simulating an OWNER
    // having granted it earlier.
    await prisma.orgMemberWorkRole.create({
      data: { orgMemberId: targetMemberId, workRoleId: complianceOfficerRoleId },
    });

    try {
      getAuthContext.mockResolvedValue(limitedCtx());

      const res = await PUT(putRequest(targetMemberId, []), { params: paramsFor(targetMemberId) });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.workRoleIds).toEqual([]);

      const rows = await prisma.orgMemberWorkRole.findMany({ where: { orgMemberId: targetMemberId } });
      expect(rows).toHaveLength(0);
    } finally {
      await prisma.orgMemberWorkRole.deleteMany({ where: { orgMemberId: targetMemberId } });
    }
  });

  it("a roleId belonging to another org → 400 unknown work role, DB unchanged", async () => {
    getAuthContext.mockResolvedValue(ownerCtx());

    const res = await PUT(
      putRequest(targetMemberId, [otherOrgRoleId]),
      { params: paramsFor(targetMemberId) },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown work role" });

    const rows = await prisma.orgMemberWorkRole.findMany({ where: { orgMemberId: targetMemberId } });
    expect(rows).toHaveLength(0);
  });

  it("a memberId belonging to another org → 404", async () => {
    getAuthContext.mockResolvedValue(ownerCtx());

    const res = await PUT(
      putRequest(otherOrgMemberId, [projectManagerRoleId]),
      { params: paramsFor(otherOrgMemberId) },
    );

    expect(res.status).toBe(404);
  });

  it("ctx lacking ORG_MANAGE_MEMBERS → 403, no DB change", async () => {
    getAuthContext.mockResolvedValue({
      userId: ACTOR_ID,
      orgId,
      orgRole: OrgRole.MEMBER,
      permissions: RolePermissions.MEMBER,
      basePermissions: RolePermissions.MEMBER,
      abacRules: [],
    } satisfies AuthContext);

    const res = await PUT(
      putRequest(targetMemberId, [projectManagerRoleId]),
      { params: paramsFor(targetMemberId) },
    );

    expect(res.status).toBe(403);

    const rows = await prisma.orgMemberWorkRole.findMany({ where: { orgMemberId: targetMemberId } });
    expect(rows).toHaveLength(0);
  });
});
