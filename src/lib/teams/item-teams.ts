/**
 * Which team's work is this?
 *
 * Work items carry no team of their own — `Team` groups project MEMBERS, and a
 * board can belong to a team, but nothing attaches an ITEM to one. So a team's
 * tasking is derived: it is the work assigned to that team's people.
 *
 * That choice is deliberate (no migration, works on existing data, nothing to
 * backfill) and it has consequences worth stating plainly, because they show up
 * on screen:
 *
 *   - An unassigned item belongs to no team, however obviously it is "for" one.
 *   - Reassigning an item moves it between teams, silently.
 *   - Someone on two teams has their work counted under both.
 *
 * The last one is why FILTERING and SWIMLANES behave differently here, and the
 * difference is intentional rather than an oversight:
 *
 *   - Filtering is a membership test, so an item can legitimately match several
 *     teams — "show me Alpha's work" should include work owned by someone who is
 *     also on Bravo.
 *   - A swimlane must place each card in exactly ONE row; the board's lane
 *     machinery assigns one lane per item and drag-and-drop encodes it in the
 *     droppable id. So the lane picks the assignee's alphabetically-first team,
 *     deterministically, rather than duplicating the card into two rows where
 *     dragging it would be ambiguous.
 */

export interface TeamLike {
  id: string;
  name: string;
  members: { userId: string }[];
}

/** userId → the teams they are on, each sorted by name. */
export function teamsByUser(teams: TeamLike[]): Map<string, TeamLike[]> {
  const byUser = new Map<string, TeamLike[]>();
  for (const team of teams) {
    for (const m of team.members) {
      const list = byUser.get(m.userId) ?? [];
      list.push(team);
      byUser.set(m.userId, list);
    }
  }
  for (const list of byUser.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return byUser;
}

/** The single lane an item sits in. `id: ""` is the "No team" bucket. */
export function teamLaneFor(
  assigneeId: string | null | undefined,
  byUser: Map<string, TeamLike[]>,
): { id: string; label: string } {
  if (!assigneeId) return { id: "", label: "No team" };
  const teams = byUser.get(assigneeId);
  if (!teams || teams.length === 0) return { id: "", label: "No team" };
  // Alphabetically first — `teamsByUser` already sorted, so this is stable.
  return { id: teams[0].id, label: teams[0].name };
}

/**
 * Does this item count as the given team's work?
 *
 * Unlike the lane, this is a plain membership test: an item assigned to someone
 * on both Alpha and Bravo matches BOTH, because "show me Alpha's tasking" should
 * not hide work just because its owner also helps out elsewhere.
 */
export function itemMatchesTeam(
  assigneeId: string | null | undefined,
  teamId: string | null,
  byUser: Map<string, TeamLike[]>,
): boolean {
  if (!teamId) return true; // "All teams" — the filter is inert
  if (!assigneeId) return false;
  return (byUser.get(assigneeId) ?? []).some((t) => t.id === teamId);
}
