/**
 * Which team's work is this?
 *
 * An item can name its team outright (`WorkItem.teamId`, COSMOS-204), separate
 * from who it is assigned to: a release train hands a story to a team before
 * anyone on it picks it up. When it names one, that is the answer, whoever the
 * assignee is.
 *
 * Items that name no team fall back to the older derived rule: the team's work
 * is what its people are assigned. That keeps every existing item where it
 * was, and its consequences still apply to those items only:
 *
 *   - An unassigned item with no team belongs to no team.
 *   - Reassigning it moves it between teams.
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

import type { Prisma } from "@prisma/client";

/** The two facts about an item that decide its team. */
export interface TeamOwned {
  assigneeId?: string | null;
  teamId?: string | null;
}

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

/**
 * The single lane an item sits in. `id: ""` is the "No team" bucket. `teams`
 * names the item's own team; one that is no longer on the roster falls back
 * to the assignee's.
 */
export function teamLaneFor(
  item: TeamOwned,
  byUser: Map<string, TeamLike[]>,
  teams: TeamLike[] = [],
): { id: string; label: string } {
  const own = item.teamId ? teams.find((t) => t.id === item.teamId) : undefined;
  if (own) return { id: own.id, label: own.name };
  if (!item.assigneeId) return { id: "", label: "No team" };
  const mine = byUser.get(item.assigneeId);
  if (!mine || mine.length === 0) return { id: "", label: "No team" };
  // Alphabetically first — `teamsByUser` already sorted, so this is stable.
  return { id: mine[0].id, label: mine[0].name };
}

/**
 * Does this item count as the given team's work?
 *
 * An item that names a team is that team's work and no other's. Otherwise,
 * unlike the lane, this is a plain membership test: an item assigned to
 * someone on both Alpha and Bravo matches BOTH, because "show me Alpha's
 * tasking" should not hide work just because its owner also helps out
 * elsewhere.
 */
export function itemMatchesTeam(
  item: TeamOwned,
  teamId: string | null,
  byUser: Map<string, TeamLike[]>,
): boolean {
  if (!teamId) return true; // "All teams" — the filter is inert
  if (item.teamId) return item.teamId === teamId;
  if (!item.assigneeId) return false;
  return (byUser.get(item.assigneeId) ?? []).some((t) => t.id === teamId);
}

/**
 * `itemMatchesTeam` as a query, for callers that ask the database rather than
 * filter a list already in memory (the assistant's work-item tools, and the
 * sprint planning / ceremony endpoints, which scope to one squad server-side).
 * Same rule: an item naming this team, or a team-less item assigned to one of
 * its people.
 */
export function teamWorkItemWhere(
  teamId: string,
  memberUserIds: string[],
): Prisma.WorkItemWhereInput {
  const own: Prisma.WorkItemWhereInput = { teamId };
  if (memberUserIds.length === 0) return own;
  return { OR: [own, { teamId: null, assigneeId: { in: memberUserIds } }] };
}
