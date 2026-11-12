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
import { Permission, RolePermissions } from "@/lib/rbac/permissions";

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

function invite(role: OrgRole, actorOrgRole: OrgRole, who: string, actorBasePermissions = RolePermissions[actorOrgRole]) {
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
    actorBasePermissions,
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

describe("the org's allowed-domain restriction binds every way an account is minted", () => {
  it("refuses an address off the list, whatever the account-request mode says", async () => {
    await prisma.orgSecuritySettings.upsert({
      where: { orgId },
      create: { orgId, allowedDomains: ["allowed.test"], accountRequestMode: "OPEN" },
      update: { allowedDomains: ["allowed.test"], accountRequestMode: "OPEN" },
    });
    // OPEN governs what may be SUBMITTED. It does not widen who may JOIN --
    // reading the mode here let approval mint an invitation for an address the
    // invitations endpoint would refuse outright.
    await expect(invite(OrgRole.MEMBER, OrgRole.ADMIN, "offlist")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(
      await prisma.invitation.count({
        where: { orgId, email: `zz-ci-offlist-${stamp}@example.com` },
      }),
    ).toBe(0);
  });

  it("allows an address on the list", async () => {
    const r = await createOrgInvitation({
      orgId,
      orgName: `CI ${stamp}`,
      orgSlug: slug,
      email: `zz-ci-onlist-${stamp}@allowed.test`,
      role: OrgRole.MEMBER,
      signInMethod: "oauth",
      mfaRequired: false,
      actorUserId: actorId,
      actorOrgRole: OrgRole.ADMIN,
      actorBasePermissions: RolePermissions.ADMIN,
      actorDisplayName: "Actor",
      origin: "http://localhost",
    });
    expect(r.invitation.email).toBe(`zz-ci-onlist-${stamp}@allowed.test`);
  });

  it("an empty list stays unrestricted, as it does everywhere else", async () => {
    await prisma.orgSecuritySettings.update({
      where: { orgId },
      data: { allowedDomains: [] },
    });
    const r = await invite(OrgRole.MEMBER, OrgRole.ADMIN, "nolist");
    expect(r.invitation.role).toBe(OrgRole.MEMBER);
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

describe("nobody hands out more than their own base permissions", () => {
  // A MEMBER whose work role adds ORG_MANAGE_MEMBERS reaches this function, but
  // work-role grants are not part of the ceiling: base is the MEMBER mask.
  it("refuses a MEMBER-based inviter inviting an ADMIN, and writes nothing", async () => {
    await expect(
      invite(OrgRole.ADMIN, OrgRole.MEMBER, "ceil-admin", RolePermissions.MEMBER),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await prisma.invitation.count({ where: { orgId, email: `zz-ci-ceil-admin-${stamp}@example.com` } }),
    ).toBe(0);
  });

  it("lets the same inviter invite at their own level", async () => {
    const r = await invite(OrgRole.MEMBER, OrgRole.MEMBER, "ceil-member", RolePermissions.MEMBER);
    expect(r.invitation.role).toBe(OrgRole.MEMBER);
  });

  it("counts a per-member override as part of the base", async () => {
    const r = await invite(
      OrgRole.ADMIN,
      OrgRole.MEMBER,
      "ceil-override",
      RolePermissions.MEMBER | RolePermissions.ADMIN | Permission.ORG_READ,
    );
    expect(r.invitation.role).toBe(OrgRole.ADMIN);
  });
});
