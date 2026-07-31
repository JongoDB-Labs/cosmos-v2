import { describe, it, expect } from "vitest";
import { managersByProject, type ManagerRow } from "./project-managers";

// REPORTED: a project showed a person as its "Lead" who was one of TWO people
// holding that role, and the reader expected to see the project's MANAGERS.
//
// Both halves were bugs. The display preferred LEAD over MANAGER, so a project
// with leads hid its managers; and the tie between the two leads was broken by
// "the first row wins" over a query with no `orderBy`, so which name appeared
// was down to Postgres and could change on its own.

const row = (projectId: string, displayName: string, avatarUrl: string | null = null): ManagerRow => ({
  projectId,
  orgMember: { user: { displayName, avatarUrl } },
});

describe("managersByProject", () => {
  it("returns every manager, not just one", () => {
    // The reported project has three. Showing one and silently dropping two is
    // what made the card look wrong in the first place.
    const out = managersByProject([
      row("p1", "Carol"),
      row("p1", "Alice"),
      row("p1", "Bob"),
    ]);
    expect(out.get("p1")?.map((m) => m.displayName)).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("orders deterministically regardless of the order rows arrive in", () => {
    // The actual defect: no orderBy, so row order was arbitrary and the name on
    // the card could change with nothing changing in the data.
    const a = managersByProject([row("p1", "Zoe"), row("p1", "Adam")]);
    const b = managersByProject([row("p1", "Adam"), row("p1", "Zoe")]);
    expect(a.get("p1")).toEqual(b.get("p1"));
    expect(a.get("p1")?.[0].displayName).toBe("Adam");
  });

  it("keeps projects separate", () => {
    const out = managersByProject([row("p1", "Alice"), row("p2", "Bob")]);
    expect(out.get("p1")?.map((m) => m.displayName)).toEqual(["Alice"]);
    expect(out.get("p2")?.map((m) => m.displayName)).toEqual(["Bob"]);
  });

  it("has no entry for a project with no manager", () => {
    // Rendered as nothing. A project with no manager should say so by omission
    // rather than borrow a lead to fill the space.
    expect(managersByProject([]).get("p1")).toBeUndefined();
  });

  it("carries the avatar through", () => {
    const out = managersByProject([row("p1", "Alice", "https://example.com/a.png")]);
    expect(out.get("p1")?.[0].avatarUrl).toBe("https://example.com/a.png");
  });

  it("sorts names with accents the way a reader would expect", () => {
    // Code-point ordering would put "Zoe" before "Ávila".
    const out = managersByProject([row("p1", "Zoe"), row("p1", "Ávila")]);
    expect(out.get("p1")?.map((m) => m.displayName)).toEqual(["Ávila", "Zoe"]);
  });
});
