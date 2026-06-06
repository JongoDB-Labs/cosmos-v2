import { describe, it, expect } from "vitest";
import {
  Permission,
  RolePermissions,
  permissionMaskFromKeys,
  isPermissionSubset,
  permissionNames,
} from "./permissions";

/**
 * These guard the math the work-role escalation guards rely on (work-roles
 * POST/PUT + the members assignment PUT). The security property is: an actor
 * may only author/assign a role whose grant mask is a SUBSET of their BASE
 * permissions (org-role base + member override, EXCLUDING work-role grants).
 * The bit-relationship assertions below encode "an ADMIN cannot grant the
 * OWNER-only bits" and "a MEMBER cannot grant FINANCE_MANAGE" directly.
 */
describe("permissionMaskFromKeys", () => {
  it("ORs the named bits", () => {
    const mask = permissionMaskFromKeys(["PROJECT_READ", "PROJECT_UPDATE"]);
    expect(mask).toBe(Permission.PROJECT_READ | Permission.PROJECT_UPDATE);
  });

  it("ignores unknown keys (never throws, never sets a spurious bit)", () => {
    const mask = permissionMaskFromKeys(["PROJECT_READ", "NOT_A_REAL_KEY", "__proto__"]);
    expect(mask).toBe(Permission.PROJECT_READ);
  });

  it("maps the empty list to no permissions", () => {
    expect(permissionMaskFromKeys([])).toBe(0n);
  });

  it("round-trips through permissionNames", () => {
    const keys = ["FINANCE_MANAGE", "OKR_CREATE", "CRM_READ"];
    const mask = permissionMaskFromKeys(keys);
    expect(new Set(permissionNames(mask))).toEqual(new Set(keys));
  });
});

describe("isPermissionSubset", () => {
  it("is true for the empty subset (a role granting nothing is always allowed)", () => {
    expect(isPermissionSubset(0n, 0n)).toBe(true);
    expect(isPermissionSubset(0n, RolePermissions.MEMBER)).toBe(true);
  });

  it("is true when subset === superset", () => {
    expect(isPermissionSubset(RolePermissions.ADMIN, RolePermissions.ADMIN)).toBe(true);
  });

  it("is false when the subset sets a bit the superset lacks", () => {
    const mask = Permission.PROJECT_READ | Permission.ORG_DELETE;
    expect(isPermissionSubset(mask, Permission.PROJECT_READ)).toBe(false);
  });

  it("OWNER's base is a superset of every single permission bit", () => {
    for (const bit of Object.values(Permission)) {
      expect(isPermissionSubset(bit, RolePermissions.OWNER)).toBe(true);
    }
  });

  it("OWNER can grant any role the schema permits (mask of all keys)", () => {
    const everything = permissionMaskFromKeys(Object.keys(Permission));
    expect(isPermissionSubset(everything, RolePermissions.OWNER)).toBe(true);
  });
});

describe("escalation invariants (the ceiling a non-OWNER may grant/assign)", () => {
  // The two bits OWNER holds that ADMIN does not — the canonical escalation
  // targets the work-role assignment guard must block for a non-OWNER.
  it("ADMIN's base does NOT cover ORG_DELETE or ORG_MANAGE_BILLING", () => {
    expect(isPermissionSubset(Permission.ORG_DELETE, RolePermissions.ADMIN)).toBe(false);
    expect(isPermissionSubset(Permission.ORG_MANAGE_BILLING, RolePermissions.ADMIN)).toBe(false);
  });

  it("an ADMIN cannot author/assign a role granting an OWNER-only bit", () => {
    const overprivileged = permissionMaskFromKeys([
      "PROJECT_READ",
      "ORG_MANAGE_BILLING",
    ]);
    // basePermissions = ADMIN base → guard must reject.
    expect(isPermissionSubset(overprivileged, RolePermissions.ADMIN)).toBe(false);
  });

  it("an ADMIN CAN author/assign a role within their own base", () => {
    const ok = permissionMaskFromKeys(["PROJECT_DELETE", "FINANCE_MANAGE", "CRM_DELETE"]);
    expect(isPermissionSubset(ok, RolePermissions.ADMIN)).toBe(true);
  });

  it("a MEMBER cannot grant FINANCE_MANAGE (it is outside their base)", () => {
    expect(isPermissionSubset(Permission.FINANCE_MANAGE, RolePermissions.MEMBER)).toBe(false);
  });

  it("the laundering loop is closed: a self-assigned grant is NOT in the base ceiling", () => {
    // Model the attack: a MEMBER was assigned a work-role granting FINANCE_MANAGE.
    // Their *effective* permissions now include it, but the grant ceiling is
    // basePermissions (MEMBER base, which excludes work-role grants), so they
    // still cannot mint or spread a FINANCE_MANAGE role.
    const base = RolePermissions.MEMBER;
    const effective = base | Permission.FINANCE_MANAGE; // widened by the assignment
    const newRoleMask = permissionMaskFromKeys(["FINANCE_MANAGE"]);
    expect(isPermissionSubset(newRoleMask, effective)).toBe(true); // would pass if guard used effective (the bug)
    expect(isPermissionSubset(newRoleMask, base)).toBe(false); // correct: guard uses base → blocked
  });
});
