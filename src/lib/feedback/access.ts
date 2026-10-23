import { hasPermission, Permission } from "@/lib/rbac/permissions";

/**
 * Who counts as the feedback team ("staff"). Today: ORG_UPDATE, the authority
 * that already triages status and edits any item (COSMOS-49). One helper, so a
 * dedicated FEEDBACK_MANAGE bit later is a one-line change.
 */
export function isFeedbackStaff(ctx: { permissions: bigint }): boolean {
  return hasPermission(ctx.permissions, Permission.ORG_UPDATE);
}

/**
 * May this person comment on this item? Anyone who can read the board and
 * holds COMMENT_CREATE, and the item's own author regardless: a VIEWER who
 * filed a request must be able to answer the team's clarifying question.
 */
export function canCommentOnFeedback(
  ctx: { userId: string; permissions: bigint },
  item: { authorId: string },
): boolean {
  if (!hasPermission(ctx.permissions, Permission.ORG_READ)) return false;
  return hasPermission(ctx.permissions, Permission.COMMENT_CREATE) || item.authorId === ctx.userId;
}
