import type { AuthContext } from "@/lib/rbac/check";
import { canManageBoardsInProject } from "@/lib/rbac/project-role";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";

/**
 * Who may change a board they made.
 *
 * A board is a shared row: renaming it, re-laying it out or deleting it changes
 * what everyone on the project sees. That stays with the people who manage the
 * project's boards (an org BOARD_UPDATE/BOARD_DELETE holder or a project
 * MANAGER), exactly as before. This adds one narrower grant beside it: the
 * person who CREATED a board may change that board.
 *
 * WHY THE CREATE GATE, AND NOT A NEW BIT. A MEMBER holds BOARD_CREATE and not
 * BOARD_UPDATE, so before this a member could make a dashboard and then could
 * not save a single change to it — the one thing a personal standup dashboard
 * needs. Granting BOARD_UPDATE would have let every member re-lay-out every
 * shared board. Instead the owner path asks the SAME question creation asked
 * (`canManageBoardsInProject`: the org bit, the project role — a project
 * VIEWER is refused — and an API key's project scope and scopes), and then
 * asks whether this is their board. Someone who could no longer create a board
 * here can no longer change the ones they made.
 *
 * What the owner path does NOT cover is decided by the routes, not here:
 * assigning a board to a team, changing its type and moving it in the tab
 * order are project-management acts and keep the manager gate.
 */
export async function canManageOwnBoard(
  ctx: AuthContext,
  projectId: string,
  board: { ownerId: string | null },
): Promise<boolean> {
  if (!board.ownerId || board.ownerId !== ctx.userId) return false;
  return canManageBoardsInProject(ctx, projectId);
}

/** The board fields its owner may change without managing the project. */
export const OWNER_EDITABLE_BOARD_FIELDS = ["name", "config"] as const;

/**
 * May this caller change the layout EVERYONE sees on this board?
 *
 * The same three-way answer the board PUT route gives a `config` change: an
 * org BOARD_UPDATE holder, a project manager, or the board's own creator. The
 * builder page asks it to decide which layout it opens — a caller who gets
 * `false` edits only their own arrangement (`…/my-layout`). The route enforces
 * the same rule on its own; this only keeps the page from offering a Save the
 * server would refuse.
 */
export async function canEditSharedLayout(
  ctx: AuthContext,
  projectId: string,
  board: { ownerId: string | null },
): Promise<boolean> {
  if (hasPermission(ctx.permissions, Permission.BOARD_UPDATE)) return true;
  if (await canManageProject(ctx, projectId, Permission.BOARD_UPDATE)) return true;
  return canManageOwnBoard(ctx, projectId, board);
}
