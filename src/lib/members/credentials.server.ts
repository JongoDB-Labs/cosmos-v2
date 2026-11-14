import type { Prisma } from "@prisma/client";
import { deleteMemberKeysIn } from "@/lib/auth/api-key-manage.server";
import { revokeMemberCalendarFeedsIn } from "@/lib/calendar/feed-revoke.server";

/**
 * End every credential a member holds in an org that works without them
 * signing in: their API keys (deleted) and their calendar links (revoked).
 * Each is audited on their membership, inside `tx`, so the membership change
 * and the credentials it ends commit together.
 *
 * Removing a member calls this, and so does every path that reinstates one:
 * re-adding them (members POST) and an SSO sign-in the identity provider still
 * vouches for (completeSsoLogin). Reinstating clears `removedAt` on the same
 * row, so anything made before the removal would otherwise work again. A new
 * path that writes `removedAt` should call this too.
 */
export async function endMemberCredentialsIn(
  tx: Pick<Prisma.TransactionClient, "apiKey" | "calendarFeed" | "auditLog">,
  p: Parameters<typeof deleteMemberKeysIn>[1],
): Promise<{ apiKeys: number; calendarFeeds: number }> {
  const apiKeys = await deleteMemberKeysIn(tx, p);
  const calendarFeeds = await revokeMemberCalendarFeedsIn(tx, p);
  return { apiKeys, calendarFeeds };
}
