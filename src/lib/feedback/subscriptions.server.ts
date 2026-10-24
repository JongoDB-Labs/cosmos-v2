import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

export type SubscriptionReason = "author" | "voter" | "commenter" | "mention" | "manual" | "merged";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Subscribe someone to a feedback item, keeping the FIRST reason. Never undoes
 * an explicit opt-out: voting or commenting again must not override "stop
 * telling me about this".
 */
export async function ensureSubscribed(
  db: Db,
  input: { orgId: string; feedbackItemId: string; userId: string; reason: SubscriptionReason },
): Promise<void> {
  await db.feedbackSubscription.upsert({
    where: { feedbackItemId_userId: { feedbackItemId: input.feedbackItemId, userId: input.userId } },
    create: input,
    update: {},
  });
}

/**
 * The person's own choice: follow (clears an opt-out) or stop following. Either
 * way the row becomes theirs ("manual"), so nothing automatic, an undone merge
 * included, takes it back.
 */
export async function setFollowing(
  db: Db,
  input: { orgId: string; feedbackItemId: string; userId: string; following: boolean },
): Promise<void> {
  const where = { feedbackItemId_userId: { feedbackItemId: input.feedbackItemId, userId: input.userId } };
  if (input.following) {
    await db.feedbackSubscription.upsert({
      where,
      create: { orgId: input.orgId, feedbackItemId: input.feedbackItemId, userId: input.userId, reason: "manual" },
      update: { unsubscribedAt: null, reason: "manual" },
    });
  } else {
    await db.feedbackSubscription.upsert({
      where,
      create: {
        orgId: input.orgId,
        feedbackItemId: input.feedbackItemId,
        userId: input.userId,
        reason: "manual",
        unsubscribedAt: new Date(),
      },
      update: { unsubscribedAt: new Date(), reason: "manual" },
    });
  }
}

/** Whether this person currently follows the item. */
export async function isFollowing(feedbackItemId: string, userId: string): Promise<boolean> {
  const row = await prisma.feedbackSubscription.findUnique({
    where: { feedbackItemId_userId: { feedbackItemId, userId } },
    select: { unsubscribedAt: true },
  });
  return !!row && row.unsubscribedAt === null;
}

/** Everyone currently following the item (opted-out rows excluded). */
export async function activeSubscriberIds(feedbackItemId: string): Promise<string[]> {
  const rows = await prisma.feedbackSubscription.findMany({
    where: { feedbackItemId, unsubscribedAt: null },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}
