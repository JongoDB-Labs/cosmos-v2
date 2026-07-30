// Reported from the New Risk dialog: the Branch picker read
// "LOE1 LOE 1 — Authorize, Cloud & Data" — the LOE number twice. Every PM
// register built its label as `${code} ${name}`, and the seeded names already
// lead with their own number.
import { describe, it, expect } from "vitest";
import { branchLabel } from "./branch-label";

describe("branchLabel", () => {
  it("does not repeat a code the name already leads with", () => {
    // The exact reported case. "LOE1" vs a name starting "LOE 1" — the match has
    // to survive the missing space.
    expect(branchLabel("LOE1", "LOE 1 — Authorize, Cloud & Data")).toBe(
      "LOE 1 — Authorize, Cloud & Data",
    );
  });

  it("prefixes when the name does not carry the code", () => {
    expect(branchLabel("LOE2", "Authorize, Cloud & Data")).toBe(
      "LOE2 — Authorize, Cloud & Data",
    );
  });

  it("ignores case when deciding", () => {
    expect(branchLabel("loe1", "LOE 1 — Foo")).toBe("LOE 1 — Foo");
  });

  it("keeps a name that merely contains the code later on", () => {
    // Only a LEADING code is a stutter; one mentioned mid-name is real content.
    expect(branchLabel("LOE3", "Migrate the LOE3 tooling")).toBe(
      "LOE3 — Migrate the LOE3 tooling",
    );
  });

  it("handles a missing half without emitting a stray dash", () => {
    expect(branchLabel("LOE1", "")).toBe("LOE1");
    expect(branchLabel("", "Authorize")).toBe("Authorize");
    expect(branchLabel("  ", "  Authorize  ")).toBe("Authorize");
  });
});
