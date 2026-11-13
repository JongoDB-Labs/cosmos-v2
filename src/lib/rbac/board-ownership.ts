import type { AuthContext } from "@/lib/rbac/check";
import { rendersSavedWidgets } from "@/lib/boards/board-types";
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
 * ONLY BOARDS THAT DRAW SAVED WIDGETS. The grant exists so a person can lay
 * out the dashboard they made. On every other type, `config` is not a layout:
 * a ceremony board's `showNoteAuthors` un-anonymises colleagues' notes, its
 * `classification` sets the banner, and a Kanban board's `wipHardEnforce` is
 * read by the workflow engine for the whole project. Those stay with managers,
 * so a Retro or Kanban board's creator holds no owner rights at all
 * (`isOwnLayoutBoard`).
 *
 * What else the owner path does NOT cover is decided by the routes: assigning a
 * board to a team, changing its type and moving it in the tab order are
 * project-management acts and keep the manager gate; within `config`, only the
 * layout keys are written (`mergeOwnerConfig`); and a board with ceremony
 * history is not theirs to delete.
 */
export async function canManageOwnBoard(
  ctx: AuthContext,
  projectId: string,
  board: { ownerId: string | null; type: string },
): Promise<boolean> {
  if (!isOwnLayoutBoard(board, ctx.userId)) return false;
  return canManageBoardsInProject(ctx, projectId);
}

/**
 * The pure half of `canManageOwnBoard`: this user made the board, and it is a
 * board whose `config` is a widget layout. Pages that already know the create
 * gate's answer for the project (the tab strip) use this without a query.
 */
export function isOwnLayoutBoard(board: { ownerId: string | null; type: string }, userId: string): boolean {
  return board.ownerId !== null && board.ownerId === userId && rendersSavedWidgets(board.type);
}

/** The board fields its owner may change without managing the project. */
export const OWNER_EDITABLE_BOARD_FIELDS = ["name", "config"] as const;

/** The `config` keys that ARE the layout, and the only ones an owner writes. */
export const OWNER_LAYOUT_CONFIG_KEYS = ["widgets"] as const;

/**
 * The config an owner's PUT stores: the stored config, with only the layout
 * keys taken from what they sent. Anything else they send — a manager-only key
 * like `showNoteAuthors`, `wipHardEnforce` or `classification`, or the board's
 * query baseline — keeps its stored value. Not a refusal, because the builder
 * sends the whole config back (it spreads what it loaded, so nothing it does
 * not own is erased); refusing every key it echoes would refuse every save.
 */
export function mergeOwnerConfig(stored: unknown, sent: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> =
    stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {};
  for (const key of OWNER_LAYOUT_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sent, key)) out[key] = sent[key];
  }
  return out;
}

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
  board: { ownerId: string | null; type: string },
): Promise<boolean> {
  if (hasPermission(ctx.permissions, Permission.BOARD_UPDATE)) return true;
  if (await canManageProject(ctx, projectId, Permission.BOARD_UPDATE)) return true;
  return canManageOwnBoard(ctx, projectId, board);
}
