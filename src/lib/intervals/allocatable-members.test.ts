import { describe, it, expect } from "vitest";
import { allocatableMembers, type ProjectMemberRow } from "./allocatable-members";

// Who may be given sprint capacity.
//
// Both capacity dialogs used `useOrgMembers` — a hook that lives in
// components/chat/mention-picker.tsx and exists for the @-mention typeahead.
// For mentions, listing every org member including bots is CORRECT: you do want
// to @-mention Foreman. Reusing it for capacity inherited two bugs at once:
//
//   1. everyone in the ORG appeared, not the people on the project;
//   2. bots appeared, so Foreman (the Foreman plugin's agent) was offered a
//      capacity allocation in points/hours it cannot possibly have.
//
// Capacity is a claim about human availability, so it needs its own rule.

const alice: ProjectMemberRow = {
  id: "pm1",
  userId: "u1",
  displayName: "Alice",
  email: "alice@example.com",
  avatarUrl: null,
  isBot: false,
  teamIds: ["t1"],
};
const bob: ProjectMemberRow = {
  id: "pm2",
  userId: "u2",
  displayName: "Bob",
  email: "bob@example.com",
  avatarUrl: null,
  isBot: false,
  teamIds: ["t2"],
};
const foreman: ProjectMemberRow = {
  id: "pm3",
  userId: "u3",
  displayName: "Foreman",
  email: "foreman@bot.local",
  avatarUrl: null,
  isBot: true,
  teamIds: [],
};
const unassigned: ProjectMemberRow = {
  id: "pm4",
  userId: "u4",
  displayName: "Dana",
  email: "dana@example.com",
  avatarUrl: null,
  isBot: false,
  teamIds: [],
};

describe("allocatableMembers", () => {
  it("excludes bots — a bot has no capacity to allocate", () => {
    const out = allocatableMembers([alice, foreman, bob]);
    expect(out.map((m) => m.displayName)).toEqual(["Alice", "Bob"]);
  });

  it("keeps everyone on the project when no team filter is given", () => {
    // Unfiltered is the default so existing single-team projects are unchanged.
    const out = allocatableMembers([alice, bob, unassigned]);
    expect(out).toHaveLength(3);
  });

  it("narrows to the selected team when one is given", () => {
    const out = allocatableMembers([alice, bob, unassigned], { teamId: "t1" });
    expect(out.map((m) => m.displayName)).toEqual(["Alice"]);
  });

  it("still excludes bots when a team filter is given", () => {
    // A bot wrongly added to a team must not reappear through the team path.
    const botOnTeam = { ...foreman, teamIds: ["t1"] };
    const out = allocatableMembers([alice, botOnTeam], { teamId: "t1" });
    expect(out.map((m) => m.displayName)).toEqual(["Alice"]);
  });

  it("returns members not on any team when filtering by the unassigned bucket", () => {
    const out = allocatableMembers([alice, bob, unassigned], { teamId: null });
    expect(out.map((m) => m.displayName)).toEqual(["Dana"]);
  });

  it("sorts by display name so the dialog order is stable", () => {
    const out = allocatableMembers([bob, unassigned, alice]);
    expect(out.map((m) => m.displayName)).toEqual(["Alice", "Bob", "Dana"]);
  });

  it("tolerates an empty roster", () => {
    expect(allocatableMembers([])).toEqual([]);
  });
});
