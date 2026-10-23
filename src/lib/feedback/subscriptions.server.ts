import type { Prisma } from "@prisma/client";

export type SubscriptionReason = "author" | "voter" | "commenter" | "mention" | "manual" | "merged";

/**
 * Subscribe someone to a feedback item, keeping the FIRST reason. Never undoes
 * an explicit opt-out: voting or commenting again must not override "stop
 * telling me about this".
 */
export async function ensureSubscribed(
  tx: Prisma.TransactionClient,
  input: { orgId: string; feedbackItemId: string; userId: string; reason: SubscriptionReason },
): Promise<void> {
  await tx.feedbackSubscription.upsert({
    where: { feedbackItemId_userId: { feedbackItemId: input.feedbackItemId, userId: input.userId } },
    create: input,
    update: {},
  });
}
