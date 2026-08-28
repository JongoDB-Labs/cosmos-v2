import { describe, it, expect } from "vitest";
import {
  teamsByUser,
  teamsById,
  teamLaneFor,
  itemMatchesTeam,
  type TeamLike,
} from "./item-teams";

// Two ways an item can belong to a team, and these tests pin both:
//
//   - ASSIGNED (COSMOS-186): the item carries a team of its own, no assignee
//     required. It matches that team and no other.
//   - DERIVED (COSMOS-175): no team of its own, so it is whatever its assignee's
//     membership implies — the older behaviour, kept for every item nobody has
//     put a team on.
//
// The derived consequences are pinned deliberately: they are the things a reader
// notices on the board and might otherwise report as bugs.

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

describe("teamsById", () => {
  it("names a team from the id an item stores", () => {
    expect(teamsById([ALPHA, BRAVO]).get("t-bravo")?.name).toBe("Bravo");
  });

  it("has no entry for a team the project does not have", () => {
    expect(teamsById([ALPHA]).get("t-bravo")).toBeUndefined();
  });
});

describe("teamLaneFor — exactly one lane per card", () => {
  const by = teamsByUser([ALPHA, BRAVO]);
  const byId = teamsById([ALPHA, BRAVO]);

  it("puts an item in the team it is ASSIGNED to, with no assignee at all", () => {
    // The whole point of COSMOS-186: work can be a team's before anyone owns it.
    expect(teamLaneFor({ teamId: "t-bravo", assigneeId: null }, by, byId)).toEqual({
      id: "t-bravo",
      label: "Bravo",
    });
  });

  it("prefers the item's own team over the one its assignee implies", () => {
    // Otherwise moving an item to a team would not move it OFF the derived one,
    // and the control would look like it did nothing.
    expect(teamLaneFor({ teamId: "t-bravo", assigneeId: "u1" }, by, byId)).toEqual({
      id: "t-bravo",
      label: "Bravo",
    });
  });

  it("falls back to 'No team' for a team id it cannot name", () => {
    // A lane labelled with a raw GUID is worse than an honest empty bucket —
    // and this is what a caller with no `byId` gets, so it must not leak one.
    expect(teamLaneFor({ teamId: "t-ghost" }, by, byId)).toEqual({
      id: "",
      label: "No team",
    });
    expect(teamLaneFor({ teamId: "t-alpha" }, by)).toEqual({
      id: "",
      label: "No team",
    });
  });

  it("puts an item with no team of its own in its assignee's team", () => {
    expect(teamLaneFor({ assigneeId: "u1" }, by, byId)).toEqual({
      id: "t-alpha",
      label: "Alpha",
    });
  });

  it("puts an item with neither team nor assignee in 'No team'", () => {
    expect(teamLaneFor({ assigneeId: null }, by, byId)).toEqual({ id: "", label: "No team" });
    expect(teamLaneFor({}, by, byId)).toEqual({ id: "", label: "No team" });
  });

  it("puts an item owned by someone on NO team in 'No team'", () => {
    expect(teamLaneFor({ assigneeId: "outsider" }, by, byId)).toEqual({
      id: "",
      label: "No team",
    });
  });

  it("picks one derived lane deterministically when the assignee is on two teams", () => {
    // A card can only be dragged within one lane, so it must live in one.
    // Alphabetically first, and stable across renders.
    expect(teamLaneFor({ assigneeId: "u2" }, by, byId)).toEqual({
      id: "t-alpha",
      label: "Alpha",
    });
    expect(teamLaneFor({ assigneeId: "u2" }, teamsByUser([BRAVO, ALPHA]), byId)).toEqual({
      id: "t-alpha",
      label: "Alpha",
    });
  });
});

describe("itemMatchesTeam — filtering, where a derived item may match several", () => {
  const by = teamsByUser([ALPHA, BRAVO]);

  it("matches the team an item is ASSIGNED to, with no assignee", () => {
    expect(itemMatchesTeam({ teamId: "t-alpha", assigneeId: null }, "t-alpha", by)).toBe(true);
  });

  it("does not match any OTHER team once an item has one of its own", () => {
    // An explicit assignment is a stronger statement than "its owner is also on
    // Bravo" — filtering by Bravo must not surface Alpha's item.
    expect(itemMatchesTeam({ teamId: "t-alpha", assigneeId: "u2" }, "t-bravo", by)).toBe(false);
  });

  it("matches the assignee's team when the item has none of its own", () => {
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
    expect(itemMatchesTeam({ teamId: "t-alpha" }, null, by)).toBe(true);
  });

  it("excludes an item with neither team nor assignee from any specific team", () => {
    expect(itemMatchesTeam({ assigneeId: null }, "t-alpha", by)).toBe(false);
  });
});
