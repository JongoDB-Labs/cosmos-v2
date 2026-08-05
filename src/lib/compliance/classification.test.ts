import { describe, it, expect } from "vitest";
import {
  classificationApplies,
  classificationOmit,
  assertClassificationAllowed,
} from "./classification";
import { ForbiddenError } from "@/lib/rbac/check";

/**
 * Classification is GOV-only. The bug this replaces: `@default(CUI)` on four PM
 * register models, written by nobody, which stamped every commercial tenant's
 * rows as Controlled Unclassified Information.
 */

describe("classificationApplies", () => {
  it("applies to a GOV tenant", () => {
    expect(classificationApplies("GOV")).toBe(true);
  });

  it("does NOT apply to a commercial tenant", () => {
    // The whole point: an A&E practice holds no CUI authority.
    expect(classificationApplies("COMMERCIAL")).toBe(false);
  });
});

describe("classificationOmit", () => {
  it("omits the column for a commercial tenant, so it is never even read", () => {
    expect(classificationOmit("COMMERCIAL")).toEqual({ classification: true });
  });

  it("omits nothing for a GOV tenant", () => {
    expect(classificationOmit("GOV")).toBeUndefined();
  });
});

describe("assertClassificationAllowed", () => {
  it("lets a GOV tenant set a marking", () => {
    expect(() => assertClassificationAllowed("GOV", "CUI")).not.toThrow();
  });

  it("refuses to let a commercial tenant set a marking", () => {
    expect(() => assertClassificationAllowed("COMMERCIAL", "CUI")).toThrow(ForbiddenError);
  });

  it("refuses every level for a commercial tenant, not just CUI", () => {
    // PUBLIC looks harmless, but a commercial tenant has no classification
    // scheme at all — offering one level implies the others are meaningful.
    for (const level of ["PUBLIC", "UNCLASSIFIED", "FOUO", "CONFIDENTIAL"] as const) {
      expect(() => assertClassificationAllowed("COMMERCIAL", level)).toThrow(ForbiddenError);
    }
  });

  it("allows a commercial tenant to CLEAR a marking", () => {
    // Rows inherited a CUI stamp from the old default. Clearing that must not
    // be forbidden, or the wrong marking becomes unremovable.
    expect(() => assertClassificationAllowed("COMMERCIAL", null)).not.toThrow();
    expect(() => assertClassificationAllowed("COMMERCIAL", undefined)).not.toThrow();
  });
});
