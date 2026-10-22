import { describe, it, expect } from "vitest";
import { teamsByUser, teamLaneFor, itemMatchesTeam, type TeamLike } from "./item-teams";

// An item that names its own team (COSMOS-204) belongs to that team. One that
// doesn't falls back to who it is ASSIGNED to. These tests pin the
// consequences of both, since they are the things a reader will notice on the
// board and might otherwise report as bugs.

const team = (id: string, name: string, ...userIds: string[]): TeamLike => ({
  id,
  name,
  members: userIds.map((userId) => ({ userId })),
});

const ALPHA = team("t-alpha", "Alpha", "u1", "u2");
const BRAVO = team("t-bravo", "Bravo", "u2", "u3");

describe("teamsByUser", () => {
  it("maps each person to every team they are on", () => {
    const by = teamsByUser([ALPHA, BRAVO]);
    expect(by.get("u1")?.map((t) => t.name)).toEqual(["Alpha"]);
    expect(by.get("u2")?.map((t) => t.name)).toEqual(["Alpha", "Bravo"]);
    expect(by.get("u3")?.map((t) => t.name)).toEqual(["Bravo"]);
  });

  it("sorts a person's teams by name, whatever order they arrive in", () => {
    // The lane picks the first entry, so an unsorted map would make the lane
    // depend on row order — the same non-determinism that made the project
    // Lead display unpredictable.
    const by = teamsByUser([BRAVO, ALPHA]);
    expect(by.get("u2")?.map((t) => t.name)).toEqual(["Alpha", "Bravo"]);
  });

  it("has no entry for someone on no team", () => {
    expect(teamsByUser([ALPHA]).get("nobody")).toBeUndefined();
  });
});

describe("teamLaneFor — exactly one lane per card", () => {
  const by = teamsByUser([ALPHA, BRAVO]);

  it("puts an item in its assignee's team", () => {
    expect(teamLaneFor({ assigneeId: "u1" }, by)).toEqual({ id: "t-alpha", label: "Alpha" });
  });

  it("puts an UNASSIGNED item with no team of its own in 'No team'", () => {
    expect(teamLaneFor({ assigneeId: null }, by)).toEqual({ id: "", label: "No team" });
    expect(teamLaneFor({ assigneeId: undefined }, by)).toEqual({ id: "", label: "No team" });
  });

  it("puts an item owned by someone on NO team in 'No team'", () => {
    expect(teamLaneFor({ assigneeId: "outsider" }, by)).toEqual({ id: "", label: "No team" });
  });

  it("picks one lane deterministically when the assignee is on two teams", () => {
    // A card can only be dragged within one lane, so it must live in one.
    // Alphabetically first, and stable across renders.
    expect(teamLaneFor({ assigneeId: "u2" }, by)).toEqual({ id: "t-alpha", label: "Alpha" });
    expect(teamLaneFor({ assigneeId: "u2" }, teamsByUser([BRAVO, ALPHA]))).toEqual({
      id: "t-alpha",
      label: "Alpha",
    });
  });
});

describe("an item's own team (COSMOS-204)", () => {
  const by = teamsByUser([ALPHA, BRAVO]);
  const teams = [ALPHA, BRAVO];

  it("lanes an unassigned item under the team it names", () => {
    expect(teamLaneFor({ assigneeId: null, teamId: "t-bravo" }, by, teams)).toEqual({
      id: "t-bravo",
      label: "Bravo",
    });
  });

  it("prefers the named team over the assignee's", () => {
    // u1 is only on Alpha, but the item was handed to Bravo.
    expect(teamLaneFor({ assigneeId: "u1", teamId: "t-bravo" }, by, teams).id).toBe("t-bravo");
    expect(itemMatchesTeam({ assigneeId: "u1", teamId: "t-bravo" }, "t-bravo", by)).toBe(true);
    expect(itemMatchesTeam({ assigneeId: "u1", teamId: "t-bravo" }, "t-alpha", by)).toBe(false);
  });

  it("matches an unassigned item to the team it names", () => {
    expect(itemMatchesTeam({ assigneeId: null, teamId: "t-alpha" }, "t-alpha", by)).toBe(true);
  });

  it("falls back to the assignee when the named team is off the roster", () => {
    expect(teamLaneFor({ assigneeId: "u1", teamId: "t-gone" }, by, teams)).toEqual({
      id: "t-alpha",
      label: "Alpha",
    });
  });
});

describe("itemMatchesTeam — filtering, where an item may match several", () => {
  const by = teamsByUser([ALPHA, BRAVO]);

  it("matches the assignee's team", () => {
    expect(itemMatchesTeam({ assigneeId: "u1" }, "t-alpha", by)).toBe(true);
  });

  it("does not match a team the assignee is not on", () => {
    expect(itemMatchesTeam({ assigneeId: "u1" }, "t-bravo", by)).toBe(false);
  });

  it("matches BOTH teams for someone who is on both", () => {
    // Deliberately unlike the lane. "Show me Alpha's tasking" must not hide work
    // just because its owner also helps out on Bravo.
    expect(itemMatchesTeam({ assigneeId: "u2" }, "t-alpha", by)).toBe(true);
    expect(itemMatchesTeam({ assigneeId: "u2" }, "t-bravo", by)).toBe(true);
  });

  it("is inert when no team is selected — 'All teams' hides nothing", () => {
    expect(itemMatchesTeam({ assigneeId: "u1" }, null, by)).toBe(true);
    expect(itemMatchesTeam({ assigneeId: null }, null, by)).toBe(true);
  });

  it("excludes an unassigned item from any specific team", () => {
    expect(itemMatchesTeam({ assigneeId: null }, "t-alpha", by)).toBe(false);
  });
});
