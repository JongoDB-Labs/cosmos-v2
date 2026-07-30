import { describe, it, expect } from "vitest";
import {
  resolveLinkTypeId,
  orderByPreferredType,
  FALLBACK_LINK_TYPE_NAME,
} from "./link-type-default";

// The realistic shape: built-ins are sector-prefixed, "Feature" is a CUSTOM
// type with a BARE key. Every test carries both so a key-building regression
// has something to trip over.
const TYPES = [
  { id: "t-story", name: "Story", key: "software.story" },
  { id: "t-epic", name: "Epic", key: "software.epic" },
  { id: "t-feature", name: "Feature", key: "feature" }, // bare, custom
];

describe("resolveLinkTypeId", () => {
  it("defaults to the type named Feature when nothing is configured", () => {
    expect(resolveLinkTypeId(null, TYPES)).toBe("t-feature");
    expect(resolveLinkTypeId(undefined, TYPES)).toBe("t-feature");
  });

  it("resolves Feature by NAME, whatever its key namespace is", () => {
    // The same org's Feature with a PREFIXED key must resolve identically. If
    // resolution ever went via a constructed `${sector}.feature`, one of these
    // two would fail — that is the exact break this guards.
    const prefixed = [
      { id: "t-story", name: "Story", key: "software.story" },
      { id: "t-feature-x", name: "Feature", key: "software.feature" },
    ];
    expect(resolveLinkTypeId(null, prefixed)).toBe("t-feature-x");
    expect(resolveLinkTypeId(null, TYPES)).toBe("t-feature");
  });

  it("honours a configured type over the Feature default", () => {
    expect(resolveLinkTypeId("t-epic", TYPES)).toBe("t-epic");
  });

  it("falls back when the configured type no longer exists", () => {
    // The column carries no FK precisely so a retired type degrades instead of
    // blocking the delete or stranding the picker.
    expect(resolveLinkTypeId("t-retired", TYPES)).toBe("t-feature");
  });

  it("returns null when the org has no Feature type and nothing is configured", () => {
    const noFeature = [{ id: "t-story", name: "Story", key: "software.story" }];
    expect(resolveLinkTypeId(null, noFeature)).toBeNull();
    // ...and a dangling id with no fallback is still null, not the dangling id.
    expect(resolveLinkTypeId("t-gone", noFeature)).toBeNull();
  });

  it("matches the fallback name case- and whitespace-insensitively", () => {
    expect(resolveLinkTypeId(null, [{ id: "t1", name: "  feature " }])).toBe("t1");
    expect(FALLBACK_LINK_TYPE_NAME).toBe("Feature");
  });
});

describe("orderByPreferredType", () => {
  const items = [
    { id: "a", workItemTypeId: "t-story" },
    { id: "b", workItemTypeId: "t-feature" },
    { id: "c", workItemTypeId: "t-story" },
    { id: "d", workItemTypeId: "t-feature" },
  ];

  it("puts the preferred type first without dropping the others", () => {
    // Ordering, not filtering — an org mid-transition still has Story links and
    // hiding them would strand those KRs.
    const out = orderByPreferredType(items, "t-feature");
    expect(out.map((i) => i.id)).toEqual(["b", "d", "a", "c"]);
    expect(out).toHaveLength(items.length);
  });

  it("is stable within each half so the caller's own sort survives", () => {
    const out = orderByPreferredType(items, "t-feature");
    expect(out.slice(0, 2).map((i) => i.id)).toEqual(["b", "d"]);
    expect(out.slice(2).map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("leaves the order alone when there is no preference", () => {
    expect(orderByPreferredType(items, null).map((i) => i.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("does not mutate its input", () => {
    const copy = [...items];
    orderByPreferredType(items, "t-feature");
    expect(items).toEqual(copy);
  });

  it("treats an untyped item as 'other' rather than crashing", () => {
    const withNull = [{ id: "x", workItemTypeId: null }, { id: "y", workItemTypeId: "t-feature" }];
    expect(orderByPreferredType(withNull, "t-feature").map((i) => i.id)).toEqual([
      "y",
      "x",
    ]);
  });
});
