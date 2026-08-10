import { describe, it, expect } from "vitest";
import { typesForSector } from "./use-work-item-types";

/**
 * Fixture mirroring the real shape of production's catalogue: sector-namespaced
 * built-ins, the universal `cross.*` namespace, and one bare-keyed org custom
 * type. Counts match prod at the time of writing (software 5, cross 8, aec 9).
 */
const TYPES = [
  { id: "sw-task", key: "software.task" },
  { id: "sw-epic", key: "software.epic" },
  { id: "sw-bug", key: "software.bug" },
  { id: "aec-permit", key: "aec.permit" },
  { id: "aec-rfi", key: "aec.rfi" },
  { id: "mfg-order", key: "manufacturing.production_order" },
  { id: "edu-course", key: "education.course" },
  { id: "cross-risk", key: "cross.risk" },
  { id: "cross-milestone", key: "cross.milestone" },
  { id: "custom-feature", key: "feature" }, // org custom, bare key
];

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("typesForSector", () => {
  it("keeps the project's own sector", () => {
    const kept = ids(typesForSector(TYPES, "software"));
    expect(kept).toContain("sw-task");
    expect(kept).toContain("sw-epic");
    expect(kept).toContain("sw-bug");
  });

  it("drops every other sector — the reported defect", () => {
    // A fresh Consulting project offered Permit, Safety Incident, Course and
    // Production Order. Those are the ones that must go.
    const kept = ids(typesForSector(TYPES, "software"));
    expect(kept).not.toContain("aec-permit");
    expect(kept).not.toContain("aec-rfi");
    expect(kept).not.toContain("mfg-order");
    expect(kept).not.toContain("edu-course");
  });

  it("keeps the universal cross.* namespace, which belongs to every sector", () => {
    const kept = ids(typesForSector(TYPES, "software"));
    expect(kept).toContain("cross-risk");
    expect(kept).toContain("cross-milestone");
    // And for a completely different sector too.
    expect(ids(typesForSector(TYPES, "aec"))).toContain("cross-risk");
  });

  it("keeps bare-keyed custom types, which belong to no sector", () => {
    // An org's own "Feature" has key `feature` with no namespace. Hiding it
    // would make a custom type unreachable in the project that defined it.
    expect(ids(typesForSector(TYPES, "software"))).toContain("custom-feature");
    expect(ids(typesForSector(TYPES, "aec"))).toContain("custom-feature");
  });

  it("returns everything when the sector is unknown", () => {
    // Fail open. A project whose template is missing, or whose sector has not
    // loaded yet, must not silently lose two thirds of its type picker.
    expect(typesForSector(TYPES, null)).toHaveLength(TYPES.length);
    expect(typesForSector(TYPES, undefined)).toHaveLength(TYPES.length);
    expect(typesForSector(TYPES, "")).toHaveLength(TYPES.length);
  });

  it("keeps the current selection even when it is out of sector", () => {
    // Editing an item already filed as an out-of-sector type must render its
    // own value. Otherwise the Select shows blank and saving silently
    // reassigns the item's type. Same escape hatch as `selectableTypes`.
    const kept = ids(typesForSector(TYPES, "software", "aec-permit"));
    expect(kept).toContain("aec-permit");
    // …without letting the rest of that sector back in.
    expect(kept).not.toContain("aec-rfi");
  });

  it("narrows a realistic catalogue substantially", () => {
    // The point of the change: 10 fixture types down to software + cross +
    // custom. On prod this is 55 -> 14.
    expect(typesForSector(TYPES, "software")).toHaveLength(6);
    expect(typesForSector(TYPES, "aec")).toHaveLength(5);
  });

  it("does not mutate or reorder its input", () => {
    const before = [...TYPES];
    const out = typesForSector(TYPES, "software");
    expect(TYPES).toEqual(before);
    // Surviving rows keep their relative order, so the picker's sortOrder holds.
    expect(ids(out)).toEqual(
      ids(TYPES.filter((t) => ids(out).includes(t.id))),
    );
  });

  it("matches a namespace exactly, not as a prefix", () => {
    // "soft" must not match "software.task", or a new sector whose name is a
    // prefix of another would leak types across projects.
    const kept = ids(typesForSector(TYPES, "soft"));
    expect(kept).not.toContain("sw-task");
    // cross and bare keys still survive, since they are sector-independent.
    expect(kept).toContain("cross-risk");
    expect(kept).toContain("custom-feature");
  });
});
