import { NotFoundError, type AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { teamIdsForActor } from "@/lib/rbac/team-membership";
import { canManageProject } from "@/lib/rbac/scope";
import { visibleBoards, type BoardLike, type BoardViewer } from "@/lib/rbac/board-visibility";

/**
 * The TEAM half of board access, in one place, for every surface that reaches a
 * board.
 *
 * `board-visibility.ts` holds the rule and is deliberately pure. That is the
 * right shape for a rule — and it is also why the rule was applied in exactly
 * ONE of the places that reach a board: a pure function only runs where somebody
 * remembers to call it.
 *
 * Found 2026-08-03. `visibleBoards` was called by the project layout, so a board
 * assigned to a team vanished from the sidebar — while
 * `GET /projects/[projectId]/boards`, `GET .../boards/[boardId]`, its columns
 * and dashboard-widget routes, the board page, the board BUILDER page and
 * Cosmo's `list_boards` all returned it in full. Every one of those gates the
 * PROJECT axis correctly via `requireProjectRead`/`assertProjectRead`; none of
 * them gated the TEAM axis. Hidden on screen, readable by URL.
 *
 * This is the same defect shape as the project axis before 2.265.3, and the fix
 * is the same shape too: not "remember to filter", but a helper every consumer
 * forwards to, plus an arch test that fails when a new consumer forgets. The
 * arch test is what found the four surfaces beyond the obvious two — they are
 * reached by a CHILD id (a column, a widget), which is exactly how the agent
 * audit's third shape hid.
 *
 * It was LATENT when found — no production board had a `teamId`, because the
 * column shipped unbackfilled and nothing assigns one yet. Fixing it before the
 * feature is used is the cheap moment; once real boards carry teams this becomes
 * a live disclosure.
 */

/**
 * The viewer the rule is evaluated against.
 *
 * Extracted from the project layout VERBATIM rather than reimplemented — the
 * sidebar and the API must answer the same question the same way, and two
 * derivations of "is this person a board admin" is precisely how a filtered list
 * and an unfiltered detail route come to disagree.
 */
export async function boardViewerFor(
  ctx: AuthContext,
  projectId: string,
): Promise<BoardViewer> {
  const [teamIds, isProjectManager] = await Promise.all([
    teamIdsForActor(ctx, projectId),
    canManageProject(ctx, projectId),
  ]);
  return {
    teamIds,
    isProjectAdmin:
      ctx.orgRole === "OWNER" ||
      hasPermission(ctx.permissions, Permission.PROJECT_MANAGE) ||
      isProjectManager,
  };
}

/**
 * Narrow a project's boards to the ones this actor may see.
 *
 * For LIST surfaces. Does not gate the project axis — callers must already have
 * passed `requireProjectRead`/`assertProjectRead`, exactly as they do today.
 * The two axes are separate questions, and folding them together here would hide
 * which one a given call site is actually relying on.
 */
export async function narrowBoards<T extends BoardLike>(
  ctx: AuthContext,
  projectId: string,
  boards: T[],
): Promise<T[]> {
  if (boards.length === 0) return boards;
  return visibleBoards(boards, await boardViewerFor(ctx, projectId));
}

/** Whether this actor may open one specific board. */
export async function isBoardVisible(
  ctx: AuthContext,
  projectId: string,
  board: BoardLike,
): Promise<boolean> {
  // A board shared with the whole project short-circuits: no membership lookup,
  // and no behaviour change for the projects that have assigned no teams.
  if (board.teamId === null) return true;
  return (await narrowBoards(ctx, projectId, [board])).length === 1;
}

/**
 * The gate for DETAIL surfaces — a board reached by id, from a URL.
 *
 * Throws NotFoundError, NOT ForbiddenError, and the difference is deliberate.
 * `requireProjectRead` refuses with "Access denied by policy" because at that
 * point the actor cannot even see the project. Here they CAN see the project;
 * refusing with a 403 would confirm that a board exists on it which they are not
 * allowed to look at — turning the gate into an enumeration oracle for the very
 * team structure it exists to keep private. A board they may not see is a board
 * that is not there.
 */
export async function requireBoardRead(
  ctx: AuthContext,
  projectId: string,
  board: BoardLike | null,
): Promise<void> {
  if (!board || !(await isBoardVisible(ctx, projectId, board))) {
    throw new NotFoundError("Board not found");
  }
}
