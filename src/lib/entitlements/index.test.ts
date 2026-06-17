import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENTITLEMENTS,
  defaultEntitlementsInput,
  isModuleEnabled,
  isSectorEnabled,
  normalizeEntitlements,
} from "./index";
import { PRODUCT_PROFILES } from "@/lib/product/profiles";

describe("entitlements helpers", () => {
  it("DEFAULT_ENTITLEMENTS enables everything (null allowlists)", () => {
    expect(DEFAULT_ENTITLEMENTS.enabledModules).toBeNull();
    expect(DEFAULT_ENTITLEMENTS.enabledSectors).toBeNull();
  });

  it("normalize collapses a disabled allowlist to null (= all enabled)", () => {
    const ent = normalizeEntitlements({
      moduleAllowlistEnabled: false,
      enabledModules: ["crm"],
      sectorAllowlistEnabled: false,
      enabledSectors: ["aec"],
    });
    expect(ent.enabledModules).toBeNull();
    expect(ent.enabledSectors).toBeNull();
  });

  it("normalize turns an enabled allowlist into a Set", () => {
    const ent = normalizeEntitlements({
      moduleAllowlistEnabled: true,
      enabledModules: ["crm", "projects"],
      sectorAllowlistEnabled: true,
      enabledSectors: ["aec"],
    });
    expect(ent.enabledModules).toEqual(new Set(["crm", "projects"]));
    expect(ent.enabledSectors).toEqual(new Set(["aec"]));
  });

  it("isModuleEnabled: all-on default enables any module", () => {
    expect(isModuleEnabled(DEFAULT_ENTITLEMENTS, "analytics")).toBe(true);
  });

  it("isModuleEnabled: allowlist enables only listed modules", () => {
    const ent = normalizeEntitlements({
      moduleAllowlistEnabled: true,
      enabledModules: ["crm"],
      sectorAllowlistEnabled: false,
      enabledSectors: [],
    });
    expect(isModuleEnabled(ent, "crm")).toBe(true);
    expect(isModuleEnabled(ent, "projects")).toBe(false);
  });

  it("isModuleEnabled: FIXED modules are always on, even under an allowlist", () => {
    const ent = normalizeEntitlements({
      moduleAllowlistEnabled: true,
      enabledModules: [],
      sectorAllowlistEnabled: false,
      enabledSectors: [],
    });
    expect(isModuleEnabled(ent, "overview")).toBe(true);
    expect(isModuleEnabled(ent, "settings")).toBe(true);
    expect(isModuleEnabled(ent, "crm")).toBe(false);
  });

  it("isSectorEnabled honors the sector allowlist", () => {
    const ent = normalizeEntitlements({
      moduleAllowlistEnabled: false,
      enabledModules: [],
      sectorAllowlistEnabled: true,
      enabledSectors: ["aec"],
    });
    expect(isSectorEnabled(ent, "aec")).toBe(true);
    expect(isSectorEnabled(ent, "software")).toBe(false);
  });
});

describe("defaultEntitlementsInput", () => {
  it("returns null for COSMOS (restricts nothing → row-free)", () => {
    expect(defaultEntitlementsInput(PRODUCT_PROFILES.cosmos)).toBeNull();
  });

  it("returns an AEC-sector allowlist for Pontis", () => {
    expect(defaultEntitlementsInput(PRODUCT_PROFILES.pontis)).toEqual({
      moduleAllowlistEnabled: false,
      enabledModules: [],
      sectorAllowlistEnabled: true,
      enabledSectors: ["aec"],
    });
  });
});
