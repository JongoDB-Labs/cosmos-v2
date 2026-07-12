import { describe, it, expect } from "vitest";
import { OrgRole } from "@prisma/client";
import {
  Permission,
  RolePermissions,
  permissionMaskFromKeys,
  isPermissionSubset,
  permissionNames,
  maskFromDb,
  maskToDb,
} from "./permissions";
import { resolvePermissions } from "./check";

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

/**
 * DB boundary: permission masks are stored as decimal STRINGS in TEXT columns
 * (OrgMember.permissions, WorkRole.grants) because the bitfield assigns bits
 * >= 63 (CRM_CREATE = 1n<<63n onward) that overflow Postgres BIGINT. maskFromDb
 * parses on read, maskToDb serializes on write; all math stays on bigint.
 */
describe("maskFromDb / maskToDb (DB TEXT boundary)", () => {
  it("round-trips a mask with bits >= 63 (the exact class BIGINT could not store)", () => {
    // CRM_CREATE = 1n<<63n is the first bit that overflows a signed BIGINT;
    // ACCOUNTING_CLOSE = 1n<<115n and AGENT_POLICY_MANAGE = 1n<<116n are far past it.
    const mask =
      Permission.CRM_CREATE | Permission.ACCOUNTING_CLOSE | Permission.AGENT_POLICY_MANAGE;
    const stored = maskToDb(mask);
    expect(typeof stored).toBe("string");
    expect(maskFromDb(stored)).toBe(mask);
  });

  it("round-trips a value beyond 2^100", () => {
    const mask = (1n << 200n) | (1n << 101n) | 0b111n;
    expect(maskToDb(mask)).toBe(mask.toString());
    expect(maskFromDb(maskToDb(mask))).toBe(mask);
  });

  it("maskToDb emits a plain decimal string (no 0x, no bigint 'n' suffix)", () => {
    expect(maskToDb(0n)).toBe("0");
    expect(maskToDb(255n)).toBe("255");
  });

  it("maskFromDb defaults null / undefined / '' to 0n (fresh member, no override)", () => {
    expect(maskFromDb(null)).toBe(0n);
    expect(maskFromDb(undefined)).toBe(0n);
    expect(maskFromDb("")).toBe(0n);
  });

  it("maskFromDb accepts a raw bigint passthrough (transitional callers / test mocks)", () => {
    expect(maskFromDb(Permission.CRM_CREATE)).toBe(Permission.CRM_CREATE);
    expect(maskFromDb(0n)).toBe(0n);
  });
});

describe("high-bit permission override survives the DB boundary (effective-permissions core)", () => {
  // loadEffectivePermissions reads OrgMember.permissions (now TEXT) via maskFromDb
  // and folds it into the role base with resolvePermissions. This locks the pure
  // seam of that path: a stored per-member override on a bit >= 63 must survive
  // the string round-trip and WIDEN the effective set — the class of grant that
  // couldn't even be persisted before this fix.
  it("a VIEWER with a stored ACCOUNTING_CLOSE override (bit 115) gains that bit", () => {
    const storedOverride = maskToDb(Permission.ACCOUNTING_CLOSE); // as persisted in TEXT
    const eff = resolvePermissions(OrgRole.VIEWER, maskFromDb(storedOverride));
    expect(isPermissionSubset(Permission.ACCOUNTING_CLOSE, eff)).toBe(true);
    // The override only WIDENS — the VIEWER base bits are still present.
    expect(isPermissionSubset(Permission.ORG_READ, eff)).toBe(true);
  });
});
