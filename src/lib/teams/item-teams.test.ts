import { describe, it, expect } from "vitest";
import { teamsByUser, teamLaneFor, itemMatchesTeam, type TeamLike } from "./item-teams";

// A team's tasking is derived from who its work is ASSIGNED to, because a work
// item has no team of its own. These tests pin the consequences of that, since
// they are the things a reader will notice on the board and might otherwise
// report as bugs.

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
    expect(teamLaneFor("u1", by)).toEqual({ id: "t-alpha", label: "Alpha" });
  });

  it("puts an UNASSIGNED item in 'No team'", () => {
    // The cost of deriving from the assignee: an item plainly intended for a
    // team has no team until someone owns it.
    expect(teamLaneFor(null, by)).toEqual({ id: "", label: "No team" });
    expect(teamLaneFor(undefined, by)).toEqual({ id: "", label: "No team" });
  });

  it("puts an item owned by someone on NO team in 'No team'", () => {
    expect(teamLaneFor("outsider", by)).toEqual({ id: "", label: "No team" });
  });

  it("picks one lane deterministically when the assignee is on two teams", () => {
    // A card can only be dragged within one lane, so it must live in one.
    // Alphabetically first, and stable across renders.
    expect(teamLaneFor("u2", by)).toEqual({ id: "t-alpha", label: "Alpha" });
    expect(teamLaneFor("u2", teamsByUser([BRAVO, ALPHA]))).toEqual({
      id: "t-alpha",
      label: "Alpha",
    });
  });
});

describe("itemMatchesTeam — filtering, where an item may match several", () => {
  const by = teamsByUser([ALPHA, BRAVO]);

  it("matches the assignee's team", () => {
    expect(itemMatchesTeam("u1", "t-alpha", by)).toBe(true);
  });

  it("does not match a team the assignee is not on", () => {
    expect(itemMatchesTeam("u1", "t-bravo", by)).toBe(false);
  });

  it("matches BOTH teams for someone who is on both", () => {
    // Deliberately unlike the lane. "Show me Alpha's tasking" must not hide work
    // just because its owner also helps out on Bravo.
    expect(itemMatchesTeam("u2", "t-alpha", by)).toBe(true);
    expect(itemMatchesTeam("u2", "t-bravo", by)).toBe(true);
  });

  it("is inert when no team is selected — 'All teams' hides nothing", () => {
    expect(itemMatchesTeam("u1", null, by)).toBe(true);
    expect(itemMatchesTeam(null, null, by)).toBe(true);
  });

  it("excludes an unassigned item from any specific team", () => {
    expect(itemMatchesTeam(null, "t-alpha", by)).toBe(false);
  });
});
