import { describe, it, expect } from "vitest";
import { rosterFor, unassignedMembers, type TeamLike, type MemberLike } from "./team-roster";

// Shaping the project Members screen: teams with their people, plus everyone on
// the project who is not on a team yet. #519 shipped the teams API with no
// screen; this is the logic that screen needs, kept out of the component so it
// can be tested without rendering the dashboard.

const alice: MemberLike = { id: "pm1", userId: "u1", displayName: "Alice", isBot: false };
const bob: MemberLike = { id: "pm2", userId: "u2", displayName: "Bob", isBot: false };
const dana: MemberLike = { id: "pm3", userId: "u3", displayName: "Dana", isBot: false };
const foreman: MemberLike = { id: "pm4", userId: "u4", displayName: "Foreman", isBot: true };

const alpha: TeamLike = { id: "t1", name: "Alpha", members: [{ projectMemberId: "pm1", isLead: true }] };
const beta: TeamLike = { id: "t2", name: "Beta", members: [{ projectMemberId: "pm2", isLead: false }] };

describe("rosterFor", () => {
  it("resolves a team's members to real people", () => {
    const r = rosterFor(alpha, [alice, bob, dana]);
    expect(r.map((m) => m.displayName)).toEqual(["Alice"]);
  });

  it("marks the lead", () => {
    expect(rosterFor(alpha, [alice, bob])[0].isLead).toBe(true);
    expect(rosterFor(beta, [alice, bob])[0].isLead).toBe(false);
  });

  it("skips a membership whose person is no longer on the project", () => {
    // team_members cascades on project_members delete, but a stale client cache
    // can still hold one. Rendering `undefined` as a row is worse than omitting.
    const stale: TeamLike = { id: "t3", name: "Ghost", members: [{ projectMemberId: "gone", isLead: false }] };
    expect(rosterFor(stale, [alice])).toEqual([]);
  });

  it("orders by name so the list does not jump between renders", () => {
    const both: TeamLike = {
      id: "t4",
      name: "Both",
      members: [{ projectMemberId: "pm2", isLead: false }, { projectMemberId: "pm1", isLead: false }],
    };
    expect(rosterFor(both, [alice, bob]).map((m) => m.displayName)).toEqual(["Alice", "Bob"]);
  });
});

describe("unassignedMembers", () => {
  it("returns people on the project who are on no team", () => {
    expect(unassignedMembers([alice, bob, dana], [alpha, beta]).map((m) => m.displayName)).toEqual(["Dana"]);
  });

  it("excludes bots — they are not people to staff onto a team", () => {
    expect(unassignedMembers([alice, foreman], [alpha]).map((m) => m.displayName)).toEqual([]);
  });

  it("counts someone on ANY team as assigned, not just the first", () => {
    expect(unassignedMembers([alice, bob], [alpha, beta])).toEqual([]);
  });

  it("returns everyone when there are no teams yet", () => {
    expect(unassignedMembers([alice, bob], []).map((m) => m.displayName)).toEqual(["Alice", "Bob"]);
  });

  it("orders by name", () => {
    expect(unassignedMembers([dana, alice, bob], []).map((m) => m.displayName)).toEqual(["Alice", "Bob", "Dana"]);
  });
});
