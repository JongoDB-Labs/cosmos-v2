import { describe, it, expect } from "vitest";
import {
  internalCategories,
  normalizeInternalCategories,
  checkInternalCategory,
  splitTime,
} from "./internal-categories";

const DEFAULT_INTERNAL_CATEGORIES = ["Overhead", "Business development", "Professional development"];

describe("internalCategories (org settings)", () => {
  it("defaults when the org has never set a list", () => {
    expect(internalCategories({})).toEqual([...DEFAULT_INTERNAL_CATEGORIES]);
    expect(internalCategories(null)).toEqual([...DEFAULT_INTERNAL_CATEGORIES]);
  });

  it("an EMPTY list is a choice, not a missing value", () => {
    expect(internalCategories({ time: { internalCategories: [] } })).toEqual([]);
  });

  it("reads the org's own list", () => {
    expect(internalCategories({ time: { internalCategories: ["Admin", "Marketing"] } })).toEqual(["Admin", "Marketing"]);
  });

  it("falls back to defaults on a malformed value rather than crashing", () => {
    expect(internalCategories({ time: { internalCategories: [1, 2] } })).toEqual([...DEFAULT_INTERNAL_CATEGORIES]);
  });
});

describe("normalizeInternalCategories", () => {
  it("trims, drops blanks and case-insensitive duplicates, keeps order", () => {
    expect(normalizeInternalCategories([" Overhead ", "", "overhead", "Training"])).toEqual(["Overhead", "Training"]);
  });
});

describe("checkInternalCategory", () => {
  const allowed = ["Overhead", "Business development"];

  it("no category is always fine", () => {
    expect(checkInternalCategory({ category: null, projectId: "p1", allowed })).toEqual({ ok: true, category: null });
    expect(checkInternalCategory({ category: "  ", projectId: null, allowed })).toEqual({ ok: true, category: null });
  });

  it("accepts a configured category on an entry with no project", () => {
    expect(checkInternalCategory({ category: "Overhead", projectId: null, allowed })).toEqual({ ok: true, category: "Overhead" });
  });

  it("refuses a category on project time — it would be counted twice", () => {
    const r = checkInternalCategory({ category: "Overhead", projectId: "p1", allowed });
    expect(r.ok).toBe(false);
  });

  it("refuses a category the org doesn't have", () => {
    const r = checkInternalCategory({ category: "Golf", projectId: null, allowed });
    expect(r).toMatchObject({ ok: false });
  });

  it("keeps an entry's existing category even after the org removed it", () => {
    expect(checkInternalCategory({ category: "Old name", projectId: null, allowed, previous: "Old name" })).toEqual({
      ok: true,
      category: "Old name",
    });
  });
});

describe("splitTime", () => {
  it("puts every hour in exactly one bucket, and breaks internal time down by category", () => {
    const split = splitTime(
      [
        { hours: 6, projectId: "p1" },
        { hours: 2, projectId: null, internalCategory: "Business development" },
        { hours: 1.5, projectId: null, internalCategory: "Overhead" },
        { hours: 0.5, projectId: null, internalCategory: "Overhead" },
        { hours: 1, projectId: null },
      ],
      ["Overhead", "Business development"],
    );
    expect(split).toEqual({
      projectHours: 6,
      internalHours: 4,
      unassignedHours: 1,
      byCategory: [
        { category: "Overhead", hours: 2 },
        { category: "Business development", hours: 2 },
      ],
    });
  });

  it("an entry with both a project and a category counts as project time only", () => {
    const split = splitTime([{ hours: 3, projectId: "p1", internalCategory: "Overhead" }]);
    expect(split.projectHours).toBe(3);
    expect(split.internalHours).toBe(0);
    expect(split.byCategory).toEqual([]);
  });

  it("categories the org no longer lists sort after its own, alphabetically", () => {
    const split = splitTime(
      [
        { hours: 1, projectId: null, internalCategory: "Zeta" },
        { hours: 1, projectId: null, internalCategory: "Alpha" },
        { hours: 1, projectId: null, internalCategory: "Overhead" },
      ],
      ["Overhead"],
    );
    expect(split.byCategory.map((c) => c.category)).toEqual(["Overhead", "Alpha", "Zeta"]);
  });
});
