/**
 * Which team's work is this?
 *
 * There are two answers, and an item may have either:
 *
 *   1. ASSIGNED (COSMOS-186). The item carries a `teamId` of its own — a team
 *      was picked for it directly. This needs no assignee at all, which is the
 *      whole point: work can belong to the platform team before anyone on it has
 *      picked the work up.
 *   2. DERIVED (COSMOS-175). The item carries no `teamId`, so its team is
 *      inferred the way it always was: it is the work assigned to that team's
 *      people.
 *
 * An assigned team WINS over the derived one, for both filtering and lanes. Two
 * reasons: someone explicitly saying "this is Alpha's" is a stronger statement
 * than "its owner happens to be on Bravo", and if the derived team were kept as
 * well, moving an item to a team would not move it OFF the old one — the control
 * would appear not to work.
 *
 * Derivation is still the answer for every item nobody has assigned a team to,
 * and its consequences are unchanged and worth stating, because they show up on
 * screen:
 *
 *   - An item with neither an assignee nor a team belongs to no team.
 *   - Reassigning such an item moves it between teams, silently. (Setting the
 *     item's own team is how you stop that.)
 *   - Someone on two teams has their derived work counted under both.
 *
 * That last one is why FILTERING and SWIMLANES behave differently here, and the
 * difference is intentional rather than an oversight:
 *
 *   - Filtering is a membership test, so a DERIVED item can legitimately match
 *     several teams — "show me Alpha's work" should include work owned by
 *     someone who is also on Bravo. An ASSIGNED item matches exactly one.
 *   - A swimlane must place each card in exactly ONE row; the board's lane
 *     machinery assigns one lane per item and drag-and-drop encodes it in the
 *     droppable id. So a derived lane picks the assignee's alphabetically-first
 *     team, deterministically, rather than duplicating the card into two rows
 *     where dragging it would be ambiguous.
 */

export interface TeamLike {
  id: string;
  name: string;
  members: { userId: string }[];
}

/** The bit of a work item this module reads. */
export interface ItemTeamRef {
  /** The team the item is assigned to directly, if any (COSMOS-186). */
  teamId?: string | null;
  assigneeId?: string | null;
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

/** teamId → the team, for naming an item's own team reference. */
export function teamsById(teams: TeamLike[]): Map<string, TeamLike> {
  return new Map(teams.map((t) => [t.id, t]));
}

/**
 * The single lane an item sits in. `id: ""` is the "No team" bucket.
 *
 * `byId` is optional so a caller that only has the roster still gets the derived
 * behaviour; without it an assigned team has no name to show, so the item falls
 * into "No team" rather than into a lane labelled with a GUID.
 */
export function teamLaneFor(
  item: ItemTeamRef,
  byUser: Map<string, TeamLike[]>,
  byId: Map<string, TeamLike> = new Map(),
): { id: string; label: string } {
  if (item.teamId) {
    const team = byId.get(item.teamId);
    if (team) return { id: team.id, label: team.name };
    return { id: "", label: "No team" };
  }
  if (!item.assigneeId) return { id: "", label: "No team" };
  const teams = byUser.get(item.assigneeId);
  if (!teams || teams.length === 0) return { id: "", label: "No team" };
  // Alphabetically first — `teamsByUser` already sorted, so this is stable.
  return { id: teams[0].id, label: teams[0].name };
}

/**
 * Does this item count as the given team's work?
 *
 * An item with its own team matches that team and no other. Otherwise this is
 * the derived membership test: an item assigned to someone on both Alpha and
 * Bravo matches BOTH, because "show me Alpha's tasking" should not hide work
 * just because its owner also helps out elsewhere.
 */
export function itemMatchesTeam(
  item: ItemTeamRef,
  teamId: string | null,
  byUser: Map<string, TeamLike[]>,
): boolean {
  if (!teamId) return true; // "All teams" — the filter is inert
  if (item.teamId) return item.teamId === teamId;
  if (!item.assigneeId) return false;
  return (byUser.get(item.assigneeId) ?? []).some((t) => t.id === teamId);
}
