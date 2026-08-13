import type { TeamLike } from "./item-teams";

/**
 * Which team a sprint ceremony is about, and who is in it.
 *
 * A ceremony belongs to a TEAM. Planning listed every member of the project, so
 * a lead sizing their own sprint had to mentally subtract the other squads —
 * the equivalent of putting every scrum team in one room for each other's
 * ceremony. Capacity in particular is meaningless at project scope: a team
 * cannot commit on behalf of people it does not run.
 *
 * A team's PEOPLE are its `TeamMember` rows. A team's WORK is whatever its
 * people are assigned — items carry no team of their own — which is the same
 * rule the board filters use (see `itemMatchesTeam`).
 */

/** The sentinel a picker uses for "don't scope this" — distinct from "unset". */
export const ALL_TEAMS = "__all__";

export interface ViewerTeam {
  id: string;
  name: string;
  /** `TeamMember.isLead` — a team lead, not a project MANAGER. */
  isLead: boolean;
}

export interface CeremonyTeamResolution {
  /** The team to scope to, or null for the whole project. */
  teamId: string | null;
  /** True when the BOARD fixes it, so the viewer must not be offered a choice. */
  locked: boolean;
}

/**
 * Resolve the team a ceremony is for.
 *
 * Priority:
 *   1. the board's own team — that board IS that team's ceremony, so the choice
 *      is not the viewer's to make and the picker is not offered;
 *   2. the viewer's explicit choice, including an explicit "all teams";
 *   3. the single team they LEAD, then the single team they belong to;
 *   4. otherwise the whole project.
 *
 * Ambiguity resolves to "everyone" rather than to a guess. Picking one of a
 * multi-team lead's squads would silently hide the others, and a ceremony that
 * quietly omits people is worse than one that plainly includes too many.
 */
export function resolveCeremonyTeam({
  boardTeamId,
  selectedTeamId,
  viewerTeams,
}: {
  boardTeamId: string | null;
  selectedTeamId: string | null;
  viewerTeams: ViewerTeam[];
}): CeremonyTeamResolution {
  if (boardTeamId) return { teamId: boardTeamId, locked: true };

  // An explicit widening is an answer, not an absence — otherwise the default
  // below would snap a lead back to their own team on the next render.
  if (selectedTeamId === ALL_TEAMS) return { teamId: null, locked: false };
  if (selectedTeamId) return { teamId: selectedTeamId, locked: false };

  const led = viewerTeams.filter((t) => t.isLead);
  if (led.length === 1) return { teamId: led[0].id, locked: false };
  // Only fall back to plain membership when they lead NOTHING; a lead of two
  // squads has not told us which ceremony this is.
  if (led.length === 0 && viewerTeams.length === 1) {
    return { teamId: viewerTeams[0].id, locked: false };
  }

  return { teamId: null, locked: false };
}

/**
 * Narrow a member list to one team's people.
 *
 * `teamsByUserId` is the roster built by `teamsByUser`. A null team means the
 * whole project — but an unknown or empty team returns NOBODY rather than
 * everybody: failing open would put the entire project back in the room, which
 * is the thing this exists to prevent.
 */
export function scopeMembersToTeam<T extends { userId: string }>(
  members: T[],
  teamId: string | null,
  teamsByUserId: Map<string, TeamLike[]>,
): T[] {
  if (!teamId) return members;
  return members.filter((m) =>
    (teamsByUserId.get(m.userId) ?? []).some((t) => t.id === teamId),
  );
}
