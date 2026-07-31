import { describe, it, expect } from "vitest";
import { visibleBoards, type BoardLike } from "./board-visibility";

// The finer half of #35. teamScopedAccess answers "who can see this PROJECT";
// this answers "within a project everyone can see, which boards are a given
// team's".
//
// Null teamId means the whole project shares the board, which is every existing
// row — so nothing narrows until someone assigns one.

const shared: BoardLike = { id: "b0", teamId: null };
const alphaBoard: BoardLike = { id: "b1", teamId: "t1" };
const betaBoard: BoardLike = { id: "b2", teamId: "t2" };
const all = [shared, alphaBoard, betaBoard];

describe("visibleBoards", () => {
  it("shows shared boards to everyone, including someone on no team", () => {
    expect(visibleBoards(all, { teamIds: [] }).map((b) => b.id)).toEqual(["b0"]);
  });

  it("shows a team's own board to its members", () => {
    expect(visibleBoards(all, { teamIds: ["t1"] }).map((b) => b.id)).toEqual(["b0", "b1"]);
  });

  it("hides another team's board", () => {
    expect(visibleBoards(all, { teamIds: ["t1"] }).map((b) => b.id)).not.toContain("b2");
  });

  it("shows boards from every team the person is on, not just the first", () => {
    expect(visibleBoards(all, { teamIds: ["t1", "t2"] }).map((b) => b.id)).toEqual([
      "b0",
      "b1",
      "b2",
    ]);
  });

  it("shows everything to someone who administers the project", () => {
    // Mirrors isProjectVisible and canManageProject: a project cannot be made
    // partly invisible to the people responsible for it.
    expect(visibleBoards(all, { teamIds: [], isProjectAdmin: true }).map((b) => b.id)).toEqual([
      "b0",
      "b1",
      "b2",
    ]);
  });

  it("changes nothing for a project whose boards are all shared", () => {
    // The default, and every project until someone assigns a board to a team.
    const untouched = [shared, { id: "b9", teamId: null }];
    expect(visibleBoards(untouched, { teamIds: [] })).toEqual(untouched);
  });

  it("preserves the input order", () => {
    // The strip is ordered by sortOrder upstream; filtering must not reshuffle.
    const ordered = [betaBoard, shared, alphaBoard];
    expect(visibleBoards(ordered, { teamIds: ["t1", "t2"] }).map((b) => b.id)).toEqual([
      "b2",
      "b0",
      "b1",
    ]);
  });

  it("tolerates an empty board list", () => {
    expect(visibleBoards([], { teamIds: ["t1"] })).toEqual([]);
  });
});
