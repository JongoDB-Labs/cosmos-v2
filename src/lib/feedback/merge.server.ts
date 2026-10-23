import type { FeedbackStatus, Prisma } from "@prisma/client";

/**
 * Merging one feedback item (the duplicate) into another (the survivor), and
 * undoing it. The single writer for both intake's dedup and staff merges, so a
 * merge has exactly one shape wherever it came from.
 *
 * Shape of a merge:
 *  - The duplicate becomes MERGED, points at the survivor, and its vote count
 *    goes to 0. Its vote ROWS stay, so an undo restores them exactly; a merged
 *    item can't be voted on, so the rows never drift.
 *  - Voters the survivor didn't already have are added to it (and counted).
 *  - The duplicate's followers follow the survivor (reason "merged").
 *  - A FeedbackMerge row records what moved and the duplicate's old status.
 *
 * No chains: the survivor is resolved to the item that actually holds the
 * discussion, and an item that others were merged into can't itself be merged
 * until those are undone. So every MERGED item points at a live, unmerged one.
 */

export type MergeErrorCode = "not-found" | "self" | "cycle" | "already-merged" | "has-duplicates";

export class MergeError extends Error {
  constructor(
    readonly code: MergeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MergeError";
  }
}

const MAX_HOPS = 20;

/** Follow merge pointers from `id` to the item that holds the discussion. */
async function resolveSurvivor(tx: Prisma.TransactionClient, orgId: string, id: string, duplicateId: string) {
  let current = id;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (current === duplicateId) throw new MergeError("cycle", "That would merge the request into itself.");
    const row = await tx.feedbackItem.findFirst({
      where: { id: current, orgId },
      select: { id: true, title: true, status: true, mergedIntoId: true },
    });
    if (!row) throw new MergeError("not-found", "The request to merge into was not found.");
    if (!row.mergedIntoId) return row;
    current = row.mergedIntoId;
  }
  throw new MergeError("cycle", "Those requests form a merge loop.");
}

export async function mergeFeedback(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string;
    duplicateId: string;
    survivorId: string;
    source: "manual" | "intake";
    /** Null for an intake merge: the dedup judge made it, not a person. */
    mergedById: string | null;
  },
): Promise<{ mergeId: string; survivor: { id: string; title: string } }> {
  const { orgId, duplicateId } = input;
  if (input.survivorId === duplicateId) {
    throw new MergeError("self", "A request can't be merged into itself.");
  }
  const duplicate = await tx.feedbackItem.findFirst({
    where: { id: duplicateId, orgId },
    select: { id: true, status: true, mergedIntoId: true },
  });
  if (!duplicate) throw new MergeError("not-found", "Feedback item not found.");
  if (duplicate.mergedIntoId || duplicate.status === "MERGED") {
    throw new MergeError("already-merged", "This request is already merged.");
  }
  const children = await tx.feedbackItem.count({ where: { orgId, mergedIntoId: duplicateId } });
  if (children > 0) {
    throw new MergeError(
      "has-duplicates",
      "Other requests were merged into this one. Undo those merges first.",
    );
  }
  const survivor = await resolveSurvivor(tx, orgId, input.survivorId, duplicateId);

  // Votes: add the duplicate's voters the survivor doesn't have yet.
  const [dupVotes, survivorVotes] = await Promise.all([
    tx.feedbackVote.findMany({ where: { feedbackItemId: duplicateId }, select: { userId: true } }),
    tx.feedbackVote.findMany({ where: { feedbackItemId: survivor.id }, select: { userId: true } }),
  ]);
  const had = new Set(survivorVotes.map((v) => v.userId));
  const movedVoteUserIds = dupVotes.map((v) => v.userId).filter((u) => !had.has(u));
  if (movedVoteUserIds.length > 0) {
    await tx.feedbackVote.createMany({
      data: movedVoteUserIds.map((userId) => ({ feedbackItemId: survivor.id, userId })),
      skipDuplicates: true,
    });
    await tx.feedbackItem.update({
      where: { id: survivor.id },
      data: { voteCount: { increment: movedVoteUserIds.length } },
    });
  }

  // Followers: the duplicate's followers now follow the survivor.
  const [dupFollowers, survivorSubs] = await Promise.all([
    tx.feedbackSubscription.findMany({
      where: { feedbackItemId: duplicateId, unsubscribedAt: null },
      select: { userId: true },
    }),
    tx.feedbackSubscription.findMany({ where: { feedbackItemId: survivor.id }, select: { userId: true } }),
  ]);
  const subscribed = new Set(survivorSubs.map((s) => s.userId));
  const addedSubscriberIds = dupFollowers.map((s) => s.userId).filter((u) => !subscribed.has(u));
  if (addedSubscriberIds.length > 0) {
    await tx.feedbackSubscription.createMany({
      data: addedSubscriberIds.map((userId) => ({ orgId, feedbackItemId: survivor.id, userId, reason: "merged" })),
      skipDuplicates: true,
    });
  }

  await tx.feedbackItem.update({
    where: { id: duplicateId },
    data: { status: "MERGED", mergedIntoId: survivor.id, voteCount: 0 },
  });
  const merge = await tx.feedbackMerge.create({
    data: {
      orgId,
      duplicateId,
      survivorId: survivor.id,
      movedVoteUserIds,
      addedSubscriberIds,
      previousStatus: duplicate.status,
      source: input.source,
      mergedById: input.mergedById,
    },
    select: { id: true },
  });
  return { mergeId: merge.id, survivor: { id: survivor.id, title: survivor.title } };
}

/**
 * Undo the duplicate's merge: its status and votes come back, and the survivor
 * gives back exactly the votes and followers the merge added.
 */
export async function undoMerge(
  tx: Prisma.TransactionClient,
  input: { orgId: string; duplicateId: string; undoneById: string },
): Promise<{ restoredStatus: FeedbackStatus; survivorId: string }> {
  const { orgId, duplicateId } = input;
  const duplicate = await tx.feedbackItem.findFirst({
    where: { id: duplicateId, orgId },
    select: { id: true, status: true },
  });
  if (!duplicate) throw new MergeError("not-found", "Feedback item not found.");
  const merge = await tx.feedbackMerge.findFirst({
    where: { orgId, duplicateId, undoneAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!merge || duplicate.status !== "MERGED") {
    throw new MergeError("not-found", "This request isn't merged.");
  }

  // The survivor may since have been deleted; then there is nothing to take back.
  const survivorAlive = await tx.feedbackItem.count({ where: { id: merge.survivorId, orgId } });
  if (survivorAlive) {
    if (merge.movedVoteUserIds.length > 0) {
      const removed = await tx.feedbackVote.deleteMany({
        where: { feedbackItemId: merge.survivorId, userId: { in: merge.movedVoteUserIds } },
      });
      if (removed.count > 0) {
        await tx.feedbackItem.update({
          where: { id: merge.survivorId },
          data: { voteCount: { decrement: removed.count } },
        });
      }
    }
    if (merge.addedSubscriberIds.length > 0) {
      await tx.feedbackSubscription.deleteMany({
        where: { feedbackItemId: merge.survivorId, userId: { in: merge.addedSubscriberIds }, reason: "merged" },
      });
    }
  }

  const restoredStatus: FeedbackStatus = merge.previousStatus ?? "OPEN";
  const voteCount = await tx.feedbackVote.count({ where: { feedbackItemId: duplicateId } });
  await tx.feedbackItem.update({
    where: { id: duplicateId },
    data: { status: restoredStatus, mergedIntoId: null, voteCount },
  });
  await tx.feedbackMerge.update({
    where: { id: merge.id },
    data: { undoneAt: new Date(), undoneById: input.undoneById },
  });
  return { restoredStatus, survivorId: merge.survivorId };
}
