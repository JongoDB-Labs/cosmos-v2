/**
 * Who may be given sprint capacity.
 *
 * Both capacity dialogs sourced their roster from `useOrgMembers`, a hook that
 * lives in components/chat/mention-typeahead.tsx and exists for the @-mention
 * typeahead. For mentions its behaviour is exactly right: every org member,
 * bots included, because you genuinely do want to @-mention Foreman. Borrowing
 * it for capacity inherited two wrong answers at once —
 *
 *   1. everyone in the ORG was offered, not the people actually on the project;
 *   2. bots were offered, so the Foreman plugin's agent appeared in sprint
 *      planning asking for an allocation of points it cannot have.
 *
 * Capacity is a claim about *human availability on this project*, so it gets
 * its own rule rather than a filter bolted onto a chat concern.
 */

export interface ProjectMemberRow {
  /** ProjectMember.id */
  id: string;
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  isBot: boolean;
  /** Team.ids this member belongs to within the project. */
  teamIds: string[];
}

export interface AllocatableFilter {
  /**
   * Restrict to one team. `undefined` (or omitted) means no team filter — every
   * human on the project, which is the behaviour a project with no teams needs
   * and therefore the default. `null` selects the members on NO team, so the
   * unassigned bucket is reachable rather than invisible.
   */
  teamId?: string | null;
}

export function allocatableMembers(
  members: ProjectMemberRow[],
  filter: AllocatableFilter = {},
): ProjectMemberRow[] {
  const byTeam = (m: ProjectMemberRow): boolean => {
    if (!("teamId" in filter)) return true;
    if (filter.teamId === null) return m.teamIds.length === 0;
    return m.teamIds.includes(filter.teamId as string);
  };

  return members
    // Bots first and unconditionally: a bot wrongly added to a team must not
    // reappear through the team path.
    .filter((m) => !m.isBot)
    .filter(byTeam)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
