// @vitest-environment node
//
// Locks the PROTECTIVENESS ORDERING that the asymmetric (tighten-only) tenant-class control
// depends on: GOV is MORE protective than COMMERCIAL, "at least as protective" is the safe
// (tighten/no-op) direction, and "loosening" is its inverse. If a new TenantClass is added
// without ranking it, TENANT_CLASS_PROTECTIVENESS fails to compile — this suite guards the
// runtime semantics on top of that.
import { describe, it, expect } from "vitest";
import {
  TENANT_CLASS_PROTECTIVENESS,
  TENANT_CLASSES_BY_PROTECTIVENESS,
  isValidTenantClass,
  isAtLeastAsProtective,
  isLoosening,
} from "./tenant-class";

describe("tenant-class protectiveness ordering", () => {
  it("ranks GOV strictly more protective than COMMERCIAL", () => {
    expect(TENANT_CLASS_PROTECTIVENESS.GOV).toBeGreaterThan(
      TENANT_CLASS_PROTECTIVENESS.COMMERCIAL,
    );
  });

  it("orders classes MOST → LEAST protective", () => {
    expect(TENANT_CLASSES_BY_PROTECTIVENESS).toEqual(["GOV", "COMMERCIAL"]);
  });

  it("validates only known tenant-class strings", () => {
    expect(isValidTenantClass("GOV")).toBe(true);
    expect(isValidTenantClass("COMMERCIAL")).toBe(true);
    expect(isValidTenantClass("SECRET")).toBe(false);
    expect(isValidTenantClass("")).toBe(false);
    expect(isValidTenantClass(undefined)).toBe(false);
    expect(isValidTenantClass(1)).toBe(false);
  });

  describe("isAtLeastAsProtective (the TIGHTEN-or-no-op direction)", () => {
    it("COMMERCIAL → GOV is a tighten (allowed)", () => {
      expect(isAtLeastAsProtective("GOV", "COMMERCIAL")).toBe(true);
    });
    it("equal class is a no-op (allowed)", () => {
      expect(isAtLeastAsProtective("GOV", "GOV")).toBe(true);
      expect(isAtLeastAsProtective("COMMERCIAL", "COMMERCIAL")).toBe(true);
    });
    it("GOV → COMMERCIAL is NOT at least as protective (a loosen)", () => {
      expect(isAtLeastAsProtective("COMMERCIAL", "GOV")).toBe(false);
    });
  });

  describe("isLoosening (the platform-owner-only direction)", () => {
    it("is true only when reducing protection", () => {
      expect(isLoosening("COMMERCIAL", "GOV")).toBe(true);
    });
    it("is false for tighten or no-op", () => {
      expect(isLoosening("GOV", "COMMERCIAL")).toBe(false);
      expect(isLoosening("GOV", "GOV")).toBe(false);
      expect(isLoosening("COMMERCIAL", "COMMERCIAL")).toBe(false);
    });
    it("is exactly the inverse of isAtLeastAsProtective", () => {
      const classes: Array<"GOV" | "COMMERCIAL"> = ["GOV", "COMMERCIAL"];
      for (const target of classes) {
        for (const current of classes) {
          expect(isLoosening(target, current)).toBe(!isAtLeastAsProtective(target, current));
        }
      }
    });
  });
});
