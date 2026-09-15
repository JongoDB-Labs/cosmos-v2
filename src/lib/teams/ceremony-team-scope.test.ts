import { describe, it, expect } from "vitest";
import {
  resolveCeremonyTeam,
  scopeMembersToTeam,
  type ViewerTeam,
} from "./ceremony-team-scope";
import { teamsByUser } from "./item-teams";

/**
 * A sprint ceremony belongs to a TEAM, not to a project.
 *
 * Planning showed every member of the project, so a lead sizing their own
 * sprint had to mentally subtract three other squads — the equivalent of every
 * scrum team standing in one room for each other's ceremony.
 *
 * Two ways a ceremony gets its team, in priority order:
 *   1. the BOARD is scoped to one (`Board.teamId`) — that board IS that team's
 *      ceremony, so the choice is not the viewer's to make;
 *   2. otherwise the viewer chooses, defaulting to the team they LEAD.
 */

const team = (id: string, name: string, isLead = false): ViewerTeam => ({
  id,
  name,
  isLead,
});

describe("resolveCeremonyTeam", () => {
  it("locks to the board's team when the board has one", () => {
    // A team's own board is not a view the viewer reconfigures.
    const r = resolveCeremonyTeam({
      boardTeamId: "team-a",
      selectedTeamId: null,
      viewerTeams: [team("team-b", "B", true)],
    });
    expect(r).toEqual({ teamId: "team-a", locked: true });
  });

  it("ignores a viewer's selection when the board is scoped", () => {
    // Otherwise the lock is decorative and one lead can retarget another's board.
    const r = resolveCeremonyTeam({
      boardTeamId: "team-a",
      selectedTeamId: "team-b",
      viewerTeams: [team("team-a", "A"), team("team-b", "B")],
    });
    expect(r).toEqual({ teamId: "team-a", locked: true });
  });

  it("honours an explicit choice on an unscoped board", () => {
    const r = resolveCeremonyTeam({
      boardTeamId: null,
      selectedTeamId: "team-b",
      viewerTeams: [team("team-a", "A", true), team("team-b", "B")],
    });
    expect(r).toEqual({ teamId: "team-b", locked: false });
  });

  it("defaults to the single team the viewer LEADS", () => {
    // The lead of one squad opening a shared board is running THEIR ceremony.
    const r = resolveCeremonyTeam({
      boardTeamId: null,
      selectedTeamId: null,
      viewerTeams: [team("team-a", "A"), team("team-b", "B", true)],
    });
    expect(r).toEqual({ teamId: "team-b", locked: false });
  });

  it("prefers leading over merely belonging", () => {
    const r = resolveCeremonyTeam({
      boardTeamId: null,
      selectedTeamId: null,
      viewerTeams: [team("team-a", "A"), team("team-b", "B", true), team("team-c", "C")],
    });
    expect(r.teamId).toBe("team-b");
  });

  it("falls back to the single team the viewer belongs to", () => {
    const r = resolveCeremonyTeam({
      boardTeamId: null,
      selectedTeamId: null,
      viewerTeams: [team("team-a", "A")],
    });
    expect(r).toEqual({ teamId: "team-a", locked: false });
  });

  it("shows everyone when the viewer leads several teams", () => {
    // Guessing which of three squads a multi-team lead meant would silently
    // hide two of them; "all teams" is at least honest about being unscoped.
    const r = resolveCeremonyTeam({
      boardTeamId: null,
      selectedTeamId: null,
      viewerTeams: [team("team-a", "A", true), team("team-b", "B", true)],
    });
    expect(r).toEqual({ teamId: null, locked: false });
  });

  it("shows everyone when the viewer is on no team at all", () => {
    // A project manager with no squad must still be able to run planning.
    const r = resolveCeremonyTeam({
      boardTeamId: null,
      selectedTeamId: null,
      viewerTeams: [],
    });
    expect(r).toEqual({ teamId: null, locked: false });
  });

  it("treats an explicit 'all teams' choice as a real answer, not as absent", () => {
    // A lead who deliberately widens to the whole project must not be snapped
    // back to their own team on the next render.
    const r = resolveCeremonyTeam({
      boardTeamId: null,
      selectedTeamId: "__all__",
      viewerTeams: [team("team-a", "A", true)],
    });
    expect(r).toEqual({ teamId: null, locked: false });
  });
});

describe("scopeMembersToTeam", () => {
  // A team's people, as the rest of the app models them: membership, not a
  // field on the person.
  const roster = teamsByUser([
    { id: "team-a", name: "A", members: [{ userId: "u1" }, { userId: "u2" }] },
    { id: "team-b", name: "B", members: [{ userId: "u3" }] },
  ]);
  const members = [{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }, { userId: "u4" }];

  it("keeps only the chosen team's members", () => {
    expect(scopeMembersToTeam(members, "team-a", roster).map((m) => m.userId)).toEqual([
      "u1",
      "u2",
    ]);
  });

  it("keeps someone who is on the team AND another one", () => {
    const shared = teamsByUser([
      { id: "team-a", name: "A", members: [{ userId: "u1" }] },
      { id: "team-b", name: "B", members: [{ userId: "u1" }] },
    ]);
    expect(scopeMembersToTeam(members, "team-b", shared).map((m) => m.userId)).toEqual(["u1"]);
  });

  it("returns everyone when no team is chosen", () => {
    // The positive control: without it, a filter that dropped everything would
    // pass every assertion above.
    expect(scopeMembersToTeam(members, null, roster)).toHaveLength(4);
  });

  it("returns nobody for a team with no members rather than everybody", () => {
    // Failing open here would put the whole project back in the room, which is
    // the bug this exists to fix.
    expect(scopeMembersToTeam(members, "team-empty", roster)).toEqual([]);
  });
});
