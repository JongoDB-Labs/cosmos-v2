import { describe, it, expect } from "vitest";
import { snapshotEntry, diffSnapshots } from "./revisions";

/** Stands in for a Prisma Decimal: an object whose toString is the value. */
class FakeDecimal {
  constructor(private readonly v: string) {}
  toString() {
    return this.v;
  }
}

describe("snapshotEntry", () => {
  it("normalises a Decimal to its VALUE, not an empty object", () => {
    // The trap: JSON.stringify(new Decimal("150")) is `{}` on some paths, which
    // would record "the rate used to be nothing" — worse than no history, since
    // it reads as authoritative.
    const snap = snapshotEntry({ rate: new FakeDecimal("150.0000") });
    expect(snap.rate).toBe("150.0000");
    expect(JSON.stringify(snap)).toContain("150.0000");
  });

  it("normalises Dates to ISO strings", () => {
    const snap = snapshotEntry({ date: new Date("2026-07-20T00:00:00.000Z") });
    expect(snap.date).toBe("2026-07-20T00:00:00.000Z");
  });

  it("keeps nulls, which are meaningful history", () => {
    // "had no project, now has one" is a real change worth recording.
    expect(snapshotEntry({ projectId: null }).projectId).toBeNull();
  });

  it("keeps arrays intact", () => {
    expect(snapshotEntry({ tags: ["a", "b"] }).tags).toEqual(["a", "b"]);
  });

  it("ignores fields outside the tracked set", () => {
    const snap = snapshotEntry({ hours: 8, secretInternalField: "nope" });
    expect(snap.hours).toBe(8);
    expect(snap).not.toHaveProperty("secretInternalField");
  });

  it("skips undefined rather than recording it as a value", () => {
    expect(snapshotEntry({ hours: 8, rate: undefined })).not.toHaveProperty("rate");
  });
});

describe("diffSnapshots", () => {
  it("returns only what moved", () => {
    const before = { hours: 8, description: "same", projectId: "p1" };
    const after = { hours: 9, description: "same", projectId: "p1" };
    expect(diffSnapshots(before, after)).toEqual({ hours: 9 });
  });

  it("is empty when nothing changed — a no-op save writes no history", () => {
    const state = { hours: 8, description: "x" };
    expect(diffSnapshots(state, { ...state })).toEqual({});
  });

  it("detects a change from a value TO null", () => {
    // Clearing a project is a change; a truthiness check would miss it.
    expect(diffSnapshots({ projectId: "p1" }, { projectId: null })).toEqual({
      projectId: null,
    });
  });

  it("detects a change from null TO a value", () => {
    expect(diffSnapshots({ projectId: null }, { projectId: "p1" })).toEqual({
      projectId: "p1",
    });
  });

  it("compares arrays by VALUE, not identity", () => {
    // Two equal arrays are different objects; identity comparison would report
    // a phantom change on every save.
    expect(diffSnapshots({ tags: ["a"] }, { tags: ["a"] })).toEqual({});
    expect(diffSnapshots({ tags: ["a"] }, { tags: ["a", "b"] })).toEqual({
      tags: ["a", "b"],
    });
  });

  it("does not report a field the update did not touch", () => {
    // A PATCH-style update omits fields; omission is not a change to null.
    expect(diffSnapshots({ hours: 8, description: "x" }, { hours: 8 })).toEqual({});
  });

  it("records a void as a real change", () => {
    const changed = diffSnapshots(
      { voidedAt: null, voidReason: null },
      { voidedAt: "2026-07-31T00:00:00.000Z", voidReason: "wrong project" },
    );
    expect(changed).toEqual({
      voidedAt: "2026-07-31T00:00:00.000Z",
      voidReason: "wrong project",
    });
  });
});
