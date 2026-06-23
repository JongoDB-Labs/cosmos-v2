import { describe, it, expect } from "vitest";
import { OrgRole } from "@prisma/client";
import { Permission } from "./permissions";
import { SETTINGS_ACCESS, SETTINGS_NAV_GROUPS, canViewSettings } from "./settings-access";

const ctx = (perms: bigint) => ({ userId: "u", orgId: "o", orgRole: OrgRole.MEMBER, permissions: perms, basePermissions: perms, abacRules: [] }) as const;

describe("settings-access", () => {
  it("has an access entry for every nav href", () => {
    for (const group of SETTINGS_NAV_GROUPS) {
      for (const item of group.items) {
        expect(SETTINGS_ACCESS[item.href], `missing access for ${item.href}`).toBeDefined();
      }
    }
  });

  it("treats view:null as always-visible", () => {
    expect(canViewSettings(ctx(0n), "/settings/profile")).toBe(true);
  });

  it("requires the view permission for gated pages", () => {
    expect(canViewSettings(ctx(0n), "/settings/audit-logs")).toBe(false);
    expect(canViewSettings(ctx(Permission.AUDIT_LOG_READ), "/settings/audit-logs")).toBe(true);
  });

  it("supports any-of (array) view for the Organization page", () => {
    expect(canViewSettings(ctx(Permission.THEME_MANAGE), "/settings/organization")).toBe(true);
    expect(canViewSettings(ctx(Permission.ORG_UPDATE), "/settings/organization")).toBe(true);
    expect(canViewSettings(ctx(Permission.ORG_DELETE), "/settings/organization")).toBe(true);
    expect(canViewSettings(ctx(0n), "/settings/organization")).toBe(false);
  });

  it("fails closed for unregistered hrefs", () => {
    expect(canViewSettings(ctx(Permission.ORG_UPDATE), "/settings/does-not-exist")).toBe(false);
  });

  it("a permission-less member sees only the Account group", () => {
    const visible = SETTINGS_NAV_GROUPS
      .map((g) => ({ label: g.label, items: g.items.filter((i) => canViewSettings(ctx(0n), i.href)) }))
      .filter((g) => g.items.length > 0);
    expect(visible.map((g) => g.label)).toEqual(["Account"]);
  });
});
