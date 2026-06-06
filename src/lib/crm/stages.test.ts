import { describe, expect, it } from "vitest";
import {
  CRM_STAGE_KEYS,
  crmStageSchema,
  canonicalizeStageFilter,
} from "./stages";

describe("crmStageSchema (write validation)", () => {
  it("uppercases a lowercase stage to the canonical key", () => {
    // The exact bug it guards: a contact written with a legacy lowercase value
    // would otherwise be orphaned off the pipeline board.
    expect(crmStageSchema.parse("lead")).toBe("LEAD");
    expect(crmStageSchema.parse("closed_won")).toBe("CLOSED_WON");
  });

  it("passes an already-canonical key through unchanged", () => {
    for (const key of CRM_STAGE_KEYS) {
      expect(crmStageSchema.parse(key)).toBe(key);
    }
  });

  it("trims surrounding whitespace before validating", () => {
    expect(crmStageSchema.parse("  proposal  ")).toBe("PROPOSAL");
  });

  it("allows null/undefined so the field can be omitted", () => {
    expect(crmStageSchema.parse(null)).toBeNull();
    expect(crmStageSchema.parse(undefined)).toBeUndefined();
  });

  it("REJECTS an unknown/typo'd stage instead of coercing it", () => {
    // A 400 surfaces the client bug; silently coercing to LEAD would demote an
    // existing contact's stage on a successful-looking save.
    expect(() => crmStageSchema.parse("won")).toThrow();
    expect(() => crmStageSchema.parse("Closed-Won")).toThrow();
    expect(() => crmStageSchema.parse("")).toThrow();
  });
});

describe("canonicalizeStageFilter", () => {
  it("uppercases for case-insensitive filtering", () => {
    expect(canonicalizeStageFilter("lead")).toBe("LEAD");
  });

  it("does NOT default unknown values (so a bogus filter matches nothing)", () => {
    expect(canonicalizeStageFilter("bogus")).toBe("BOGUS");
  });
});
