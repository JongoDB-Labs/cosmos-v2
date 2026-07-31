/**
 * Which of a project's boards a person sees.
 *
 * The finer half of #35. `teamScopedAccess` answers "who can see this PROJECT
 * at all"; this answers "within a project everyone can see, which boards belong
 * to a given team".
 *
 * A board with `teamId === null` is shared with the whole project — that is
 * every existing row and the default for new ones, so nothing narrows until
 * someone assigns a board to a team. Same opt-in shape as teamScopedAccess,
 * and for the same reason: narrowing by default is how the two access-control
 * changes before it caused incidents.
 *
 * Pure and synchronous on purpose. The caller already knows the actor's teams —
 * the project layout has them, the boards route has them — so this stays a rule
 * rather than a query, and can be exercised without a database.
 */

export interface BoardLike {
  id: string;
  /** The owning team, or null when the whole project shares it. */
  teamId: string | null;
}

export interface BoardViewer {
  /** Team ids this person belongs to WITHIN the project in question. */
  teamIds: string[];
  /**
   * Org admin / owner / project MANAGER. Sees every board, matching
   * isProjectVisible and canManageProject — a project must not be partly
   * invisible to the people responsible for it.
   */
  isProjectAdmin?: boolean;
}

export function visibleBoards<T extends BoardLike>(boards: T[], viewer: BoardViewer): T[] {
  if (viewer.isProjectAdmin) return boards;
  // Membership of ANY of the actor's teams qualifies — being absent from team A
  // must not hide team B's board from someone on both.
  const mine = new Set(viewer.teamIds);
  // Filter preserves order: the strip is sorted by sortOrder upstream.
  return boards.filter((b) => b.teamId === null || mine.has(b.teamId));
}
