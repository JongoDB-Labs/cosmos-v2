import { describe, it, expect } from "vitest";
import type { OrgRole } from "@prisma/client";
import { Permission, RolePermissions, maskToDb } from "./permissions";
import {
  CEILING_MESSAGE,
  CURRENT_ACCESS_MESSAGE,
  GRANTABLE_WITHOUT_HOLDING,
  OWNER_CHANGE_MESSAGE,
  OWNER_ONLY_MESSAGE,
  currentAccessRefusal,
  grantableOrgRoles,
  heldBeyondRole,
  orgRoleGrantRefusal,
  workRoleCeilingRefusal,
} from "./grant-ceiling";

const base = (role: OrgRole, extra = 0n) => ({ orgRole: role, basePermissions: RolePermissions[role] | extra });

describe("orgRoleGrantRefusal", () => {
  it("lets an owner grant every role", () => {
    expect(grantableOrgRoles(base("OWNER"))).toEqual(["OWNER", "ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER", "GUEST"]);
  });

  it("lets an admin grant every role but owner", () => {
    expect(orgRoleGrantRefusal(base("ADMIN"), "OWNER")).toBe(OWNER_ONLY_MESSAGE);
    expect(grantableOrgRoles(base("ADMIN"))).toEqual(["ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER", "GUEST"]);
  });

  it("keeps a member at their own level, whatever their work roles add", () => {
    // A work role adds to `permissions`, never to `basePermissions`, so this is
    // what a member holding ORG_MANAGE_MEMBERS through a work role looks like.
    expect(grantableOrgRoles(base("MEMBER"))).toEqual(["MEMBER", "VIEWER", "GUEST"]);
    expect(orgRoleGrantRefusal(base("MEMBER"), "ADMIN")).toBe(CEILING_MESSAGE);
    expect(orgRoleGrantRefusal(base("MEMBER"), "BILLING_ADMIN")).toBe(CEILING_MESSAGE);
  });

  it("counts a per-member override as part of the base", () => {
    expect(orgRoleGrantRefusal(base("MEMBER", RolePermissions.ADMIN), "ADMIN")).toBeNull();
  });

  it("refuses extra bits the granter lacks, e.g. an override that would come back on reinstatement", () => {
    expect(orgRoleGrantRefusal(base("ADMIN"), "MEMBER", Permission.ORG_DELETE)).toBe(CEILING_MESSAGE);
    expect(orgRoleGrantRefusal(base("OWNER"), "MEMBER", Permission.ORG_DELETE)).toBeNull();
  });

  it("only the billing bit is held open, and only it separates admin from billing admin", () => {
    expect(GRANTABLE_WITHOUT_HOLDING).toBe(Permission.ORG_MANAGE_BILLING);
    // The exemption exists for exactly one case. If BILLING_ADMIN gains a bit
    // ADMIN lacks, this fails and the exemption needs a fresh decision.
    expect(RolePermissions.BILLING_ADMIN & ~RolePermissions.ADMIN).toBe(Permission.ORG_MANAGE_BILLING);
    // It does not let anyone grant OWNER-only bits.
    expect(orgRoleGrantRefusal(base("ADMIN"), "MEMBER", Permission.ORG_DELETE)).not.toBeNull();
  });

  it("an API key's narrowed base bounds it like anyone else's", () => {
    const key = { orgRole: "OWNER" as OrgRole, basePermissions: Permission.ORG_READ | Permission.ORG_MANAGE_MEMBERS };
    expect(orgRoleGrantRefusal(key, "ADMIN")).toBe(CEILING_MESSAGE);
    expect(orgRoleGrantRefusal(key, "OWNER")).toBe(CEILING_MESSAGE);
  });
});

describe("currentAccessRefusal (the ceiling on current role)", () => {
  it("refuses a member manager acting on an admin, and allows them a member", () => {
    expect(currentAccessRefusal(base("MEMBER"), "ADMIN")).toBe(CURRENT_ACCESS_MESSAGE);
    expect(currentAccessRefusal(base("MEMBER"), "MEMBER")).toBeNull();
  });

  it("counts the target's stored override", () => {
    expect(currentAccessRefusal(base("MEMBER"), "MEMBER", Permission.SECURITY_MANAGE)).toBe(CURRENT_ACCESS_MESSAGE);
    expect(currentAccessRefusal(base("ADMIN"), "ADMIN", Permission.ORG_DELETE)).toBe(CURRENT_ACCESS_MESSAGE);
    expect(currentAccessRefusal(base("OWNER"), "ADMIN", Permission.ORG_DELETE)).toBeNull();
  });

  it("an admin may act on admins and billing admins, but only an owner on an owner", () => {
    expect(currentAccessRefusal(base("ADMIN"), "ADMIN")).toBeNull();
    expect(currentAccessRefusal(base("ADMIN"), "BILLING_ADMIN")).toBeNull();
    expect(currentAccessRefusal(base("ADMIN"), "OWNER")).toBe(OWNER_CHANGE_MESSAGE);
    expect(currentAccessRefusal(base("OWNER"), "OWNER")).toBeNull();
  });
});

describe("workRoleCeilingRefusal", () => {
  it("is a plain subset of the base, with no billing carve-out", () => {
    expect(workRoleCeilingRefusal(base("MEMBER"), Permission.ITEM_READ)).toBeNull();
    expect(workRoleCeilingRefusal(base("MEMBER"), Permission.SECURITY_MANAGE)).toBe(CURRENT_ACCESS_MESSAGE);
    expect(workRoleCeilingRefusal(base("ADMIN"), Permission.ORG_MANAGE_BILLING)).toBe(CURRENT_ACCESS_MESSAGE);
    expect(workRoleCeilingRefusal(base("OWNER"), Permission.ORG_MANAGE_BILLING)).toBeNull();
  });
});

describe("heldBeyondRole", () => {
  it("is the stored override plus every work role's grants", () => {
    const held = heldBeyondRole({
      permissions: maskToDb(Permission.AUDIT_LOG_READ),
      workRoles: [
        { workRole: { grants: maskToDb(Permission.SECURITY_MANAGE) } },
        { workRole: { grants: maskToDb(Permission.SESSION_MANAGE) } },
      ],
    });
    expect(held).toBe(Permission.AUDIT_LOG_READ | Permission.SECURITY_MANAGE | Permission.SESSION_MANAGE);
    expect(heldBeyondRole({ permissions: "0", workRoles: [] })).toBe(0n);
  });
});
