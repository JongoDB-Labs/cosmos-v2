import { describe, it, expect } from "vitest";
import { activityFieldLabel, activityValueLabel } from "./activity-label";

const UUID = "118ec485-9938-4146-9d0b-943c007ffc64";
const resolvers = {
  user: (id: string) => (id === UUID ? "Ben Okoro" : undefined),
  cycle: (id: string) => (id === "cyc-1" ? "Sprint 3" : undefined),
  type: (id: string) => (id === "typ-1" ? "Bug" : undefined),
  column: (key: string) => (key === "in_progress" ? "In Progress" : undefined),
};

describe("activityFieldLabel", () => {
  it("humanizes the id-valued field names", () => {
    expect(activityFieldLabel("assigneeId")).toBe("assignee");
    expect(activityFieldLabel("columnKey")).toBe("status");
    expect(activityFieldLabel("cycleId")).toBe("cycle");
    expect(activityFieldLabel("workItemTypeId")).toBe("type");
  });
  it("passes unknown fields through", () => {
    expect(activityFieldLabel("title")).toBe("title");
    expect(activityFieldLabel("priority")).toBe("priority");
  });
});

describe("activityValueLabel", () => {
  it("resolves an assignee id to the person's name", () => {
    expect(activityValueLabel("assigneeId", UUID, resolvers)).toBe("Ben Okoro");
  });

  it("NEVER surfaces a raw user id — the reported bug", () => {
    // Unresolved user id (e.g. a member since removed from the org).
    const other = "99999999-9999-4999-8999-999999999999";
    const out = activityValueLabel("assigneeId", other, resolvers);
    expect(out).toBe("Unknown");
    expect(out).not.toContain("-"); // not a GUID
  });

  it("resolves cycle and type ids", () => {
    expect(activityValueLabel("cycleId", "cyc-1", resolvers)).toBe("Sprint 3");
    expect(activityValueLabel("workItemTypeId", "typ-1", resolvers)).toBe("Bug");
  });

  it("resolves a status columnKey to its column name, else the slug", () => {
    expect(activityValueLabel("columnKey", "in_progress", resolvers)).toBe("In Progress");
    expect(activityValueLabel("columnKey", "backlog", resolvers)).toBe("backlog");
  });

  it("returns non-id field values verbatim", () => {
    expect(activityValueLabel("title", "New title", resolvers)).toBe("New title");
    expect(activityValueLabel("priority", "HIGH", resolvers)).toBe("HIGH");
  });

  it("returns null for an empty value (no from/to clause)", () => {
    expect(activityValueLabel("assigneeId", null, resolvers)).toBeNull();
    expect(activityValueLabel("assigneeId", "", resolvers)).toBeNull();
  });

  it("falls back to Unknown for an unresolved GUID on any id field", () => {
    expect(activityValueLabel("cycleId", UUID, {})).toBe("Unknown");
    expect(activityValueLabel("workItemTypeId", UUID, {})).toBe("Unknown");
  });
});
