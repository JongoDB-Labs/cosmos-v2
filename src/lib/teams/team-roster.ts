/**
 * Shaping the project Members screen's Teams section.
 *
 * #519 shipped the teams API with no screen to drive it. This is the logic that
 * screen needs, kept out of the component so the rules are testable without
 * rendering the dashboard shell.
 */

export interface MemberLike {
  /** ProjectMember.id — what team membership actually FKs to. */
  id: string;
  userId: string;
  displayName: string;
  isBot: boolean;
}

export interface TeamLike {
  id: string;
  name: string;
  members: { projectMemberId: string; isLead: boolean }[];
}

export interface RosterEntry extends MemberLike {
  isLead: boolean;
}

const byName = (a: { displayName: string }, b: { displayName: string }) =>
  a.displayName.localeCompare(b.displayName);

/**
 * The people on a team, resolved from the project's roster.
 *
 * A membership whose person is no longer on the project is skipped rather than
 * rendered as a blank row. `team_members` cascades when a `project_members` row
 * goes, so this is only reachable from a stale client cache — but a row that
 * says nothing is worse than no row.
 */
export function rosterFor(team: TeamLike, members: MemberLike[]): RosterEntry[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  return team.members
    .map((tm) => {
      const person = byId.get(tm.projectMemberId);
      return person ? { ...person, isLead: tm.isLead } : null;
    })
    .filter((m): m is RosterEntry => m !== null)
    .sort(byName);
}

/**
 * People on the project who are not on any team yet — the pool the UI offers
 * when staffing one.
 *
 * Bots are excluded: the Foreman agent can be a project member, but "who is on
 * this team" is a question about people. Same rule as sprint capacity, and for
 * the same reason.
 */
export function unassignedMembers(
  members: MemberLike[],
  teams: TeamLike[],
): MemberLike[] {
  // Across ALL teams, not just the first — someone on team B is not unassigned
  // merely because they are absent from team A.
  const assigned = new Set(teams.flatMap((t) => t.members.map((m) => m.projectMemberId)));
  return members
    .filter((m) => !m.isBot)
    .filter((m) => !assigned.has(m.id))
    .sort(byName);
}
