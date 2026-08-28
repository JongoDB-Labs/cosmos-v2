import { describe, it, expect } from "vitest";
import { activityFieldLabel, activityValueLabel } from "./activity-label";

const UUID = "118ec485-9938-4146-9d0b-943c007ffc64";
const TEAM_UUID = "6a1f9d2c-4b7e-4e1a-9c3d-70f5b2a8e611";
const resolvers = {
  user: (id: string) => (id === UUID ? "Ben Okoro" : undefined),
  team: (id: string) => (id === TEAM_UUID ? "Platform" : undefined),
  interval: (id: string) => (id === "cyc-1" ? "Sprint 3" : undefined),
  type: (id: string) => (id === "typ-1" ? "Bug" : undefined),
  column: (key: string) => (key === "in_progress" ? "In Progress" : undefined),
};

describe("activityFieldLabel", () => {
  it("humanizes the id-valued field names", () => {
    expect(activityFieldLabel("assigneeId")).toBe("assignee");
    expect(activityFieldLabel("teamId")).toBe("team");
    expect(activityFieldLabel("columnKey")).toBe("status");
    expect(activityFieldLabel("intervalId")).toBe("interval");
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
    expect(out).toBeNull();
  });

  it("resolves a team id to the team's name (COSMOS-186)", () => {
    // Team assignment is recorded like every other id-valued field, so without
    // a resolver case the Activity tab would read "changed team" and drop the
    // value — or, worse, leak the GUID.
    expect(activityValueLabel("teamId", TEAM_UUID, resolvers)).toBe("Platform");
  });

  it("never surfaces a raw team id it cannot name", () => {
    expect(activityValueLabel("teamId", TEAM_UUID, {})).toBeNull();
  });

  it("resolves interval and type ids", () => {
    expect(activityValueLabel("intervalId", "cyc-1", resolvers)).toBe("Sprint 3");
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

  // BR: "Steve changed interval to Unknown" — the value clause claimed a value
  // we did not have. An id we cannot name is EITHER a since-deleted row OR a
  // lookup table that hasn't loaded; "Unknown" is false in the second case and
  // useless in the first, so the clause is dropped instead.
  it("says nothing — never 'Unknown' — for an id it cannot resolve", () => {
    expect(activityValueLabel("intervalId", UUID, {})).toBeNull();
    expect(activityValueLabel("workItemTypeId", UUID, {})).toBeNull();
    expect(activityValueLabel("assigneeId", UUID, {})).toBeNull();
  });

  it("fails closed on an id-shaped value for a field the switch doesn't know", () => {
    // `parentId` is labelled but not yet recorded as an activity; if it (or any
    // new id-valued field) starts flowing through, it must not leak a GUID.
    expect(activityValueLabel("parentId", UUID, resolvers)).toBeNull();
    expect(activityValueLabel("someFutureId", UUID, resolvers)).toBeNull();
    // A scalar that merely looks unfamiliar is still shown.
    expect(activityValueLabel("someFutureField", "13", resolvers)).toBe("13");
  });
});
