// @vitest-environment node
//
// The role ceiling on the one shared account-minting path, against the real DB.
//
// Why it lives here and not in a route: the members route has long refused a
// role CHANGE to OWNER by a non-owner, but the INVITATION path did not, so the
// same escalation was reachable by inviting instead of promoting. An ADMIN
// holding ORG_MANAGE_MEMBERS could invite an address they control as OWNER,
// accept it, and gain the OWNER-only bits (ORG_DELETE, ORG_MANAGE_BILLING).
// The guard now sits in createOrgInvitation, so the invitations endpoint and
// account-request approval are covered by one copy — these specs pin that copy.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { OrgRole } from "@prisma/client";
import { ForbiddenError } from "@/lib/rbac/check";

vi.mock("@/lib/integrations/invitation-email", () => ({
  sendInvitationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordInviteEmail: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/db/client";
import { createOrgInvitation } from "./create-invitation";

const stamp = Date.now().toString(36);
const slug = `zzci-${stamp}`;
let orgId = "";
let actorId = "";

function invite(role: OrgRole, actorOrgRole: OrgRole, who: string) {
  return createOrgInvitation({
    orgId,
    orgName: `CI ${stamp}`,
    orgSlug: slug,
    email: `zz-ci-${who}-${stamp}@example.com`,
    role,
    signInMethod: "oauth",
    mfaRequired: false,
    actorUserId: actorId,
    actorOrgRole,
    actorDisplayName: "Actor",
    origin: "http://localhost",
  });
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `CI ${stamp}`, slug } })).id;
  actorId = (
    await prisma.user.create({
      data: { email: `zz-ci-actor-${stamp}@example.com`, displayName: "Actor" },
    })
  ).id;
  await prisma.orgMember.create({
    data: { orgId, userId: actorId, role: "ADMIN", permissions: "0" },
  });
});

describe("only an owner can hand out the owner role", () => {
  it("refuses an ADMIN inviting someone as OWNER", async () => {
    await expect(invite(OrgRole.OWNER, OrgRole.ADMIN, "esc")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // Nothing was written: the guard runs before the allowlist upsert and the
    // transaction, so a refused invite leaves no trace to clean up.
    expect(
      await prisma.invitation.count({
        where: { orgId, email: `zz-ci-esc-${stamp}@example.com` },
      }),
    ).toBe(0);
    expect(
      await prisma.allowedEmail.count({ where: { email: `zz-ci-esc-${stamp}@example.com` } }),
    ).toBe(0);
  });

  it("allows an OWNER inviting someone as OWNER", async () => {
    const r = await invite(OrgRole.OWNER, OrgRole.OWNER, "owner");
    expect(r.invitation.role).toBe(OrgRole.OWNER);
  });

  it("leaves every lesser role alone — an ADMIN may still invite a MEMBER", async () => {
    for (const role of [OrgRole.ADMIN, OrgRole.MEMBER, OrgRole.VIEWER] as const) {
      const r = await invite(role, OrgRole.ADMIN, `ok-${role}`);
      expect(r.invitation.role).toBe(role);
    }
  });
});
