import type { Prisma } from "@prisma/client";
import { logAudit } from "@/lib/audit";

/**
 * Revoke the live calendar links `where` names, inside `tx`, and return their
 * ids for the audit entry the caller writes in the same transaction. Revoked,
 * not deleted: `revokedAt` is what the feed (renderFeed) and the list both
 * treat as dead, as a person's own Revoke does. A link already revoked keeps
 * the time it was revoked.
 */
export async function revokeCalendarFeedsIn(
  tx: Pick<Prisma.TransactionClient, "calendarFeed">,
  where: Prisma.CalendarFeedWhereInput,
  now: Date = new Date(),
): Promise<string[]> {
  const live = await tx.calendarFeed.findMany({ where: { ...where, revokedAt: null }, select: { id: true } });
  const ids = live.map((f) => f.id);
  if (ids.length > 0) await tx.calendarFeed.updateMany({ where: { id: { in: ids } }, data: { revokedAt: now } });
  return ids;
}

/**
 * Revoke every live calendar link `userId` has in `orgId`, inside `tx`, and
 * record it as "member.calendar_feeds_revoked" on their membership. The
 * calendar side of deleteMemberKeysIn: removing a member and every path that
 * reinstates one end both, through endMemberCredentialsIn. Reinstating clears
 * `removedAt` on the same row, so a link that survived the removal would
 * otherwise be served again. Returns how many went.
 */
export async function revokeMemberCalendarFeedsIn(
  tx: Pick<Prisma.TransactionClient, "calendarFeed" | "auditLog">,
  p: {
    orgId: string;
    userId: string;
    memberId: string;
    actorUserId: string;
    reason: "removed" | "reinstated";
    ipAddress?: string;
  },
): Promise<number> {
  const feedIds = await revokeCalendarFeedsIn(tx, { orgId: p.orgId, userId: p.userId });
  if (feedIds.length > 0) {
    await logAudit({
      orgId: p.orgId,
      userId: p.actorUserId,
      action: "member.calendar_feeds_revoked",
      entity: "org_member",
      entityId: p.memberId,
      metadata: { targetUserId: p.userId, reason: p.reason, revokedCount: feedIds.length, feedIds },
      ipAddress: p.ipAddress,
    }, tx);
  }
  return feedIds.length;
}
