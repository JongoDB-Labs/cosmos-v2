import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { ensureSubscribed } from "@/lib/feedback/subscriptions.server";

type RouteParams = { params: Promise<{ orgId: string; feedbackId: string }> };

async function resolve(orgId: string, feedbackId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  requirePermission(ctx, Permission.ORG_READ);
  const item = await prisma.feedbackItem.findFirst({
    where: { id: feedbackId, orgId },
  });
  if (!item) return { error: new Response("Not found", { status: 404 }) };
  if (item.mergedIntoId || item.status === "MERGED") return { error: mergedResponse(item.mergedIntoId) };
  return { ctx, item };
}

// A merged request's votes live on its survivor (and its own rows must stay
// exactly as they were, for an undo), so it can't be voted on or un-voted.
const mergedResponse = (mergedIntoId: string | null) =>
  new Response(JSON.stringify({ error: "This request was merged; vote on the one it was merged into.", mergedIntoId }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });

class MergedMeanwhile extends Error {
  constructor(readonly mergedIntoId: string | null) {
    super("merged");
  }
}

/**
 * Lock the item's row for the vote's transaction and check it again: a merge
 * takes the same lock, so a vote either lands before the merge moves votes or
 * sees the item merged.
 */
async function lockUnmerged(tx: Prisma.TransactionClient, feedbackId: string) {
  const [row] = await tx.$queryRaw<{ status: string; merged_into_id: string | null }[]>`
    SELECT status, merged_into_id FROM feedback_items WHERE id = ${feedbackId}::uuid FOR UPDATE`;
  if (row && (row.merged_into_id || row.status === "MERGED")) throw new MergedMeanwhile(row.merged_into_id);
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const r = await resolve(orgId, feedbackId);
    if (r.error) return r.error;
    const { ctx } = r;

    // Idempotent upvote: create the vote + bump the denormalized count in one
    // transaction; if the user already voted, the unique constraint trips and
    // we leave the count untouched.
    let voteCount = r.item.voteCount;
    try {
      const result = await prisma.$transaction(async (tx) => {
        await lockUnmerged(tx, feedbackId);
        await tx.feedbackVote.create({
          data: { feedbackItemId: feedbackId, userId: ctx.userId },
        });
        await ensureSubscribed(tx, { orgId, feedbackItemId: feedbackId, userId: ctx.userId, reason: "voter" });
        return tx.feedbackItem.update({
          where: { id: feedbackId },
          data: { voteCount: { increment: 1 } },
          select: { voteCount: true },
        });
      });
      voteCount = result.voteCount;
    } catch (e) {
      if (e instanceof MergedMeanwhile) return mergedResponse(e.mergedIntoId);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        // Already voted — we didn't change the count, but other voters may have
        // moved it since resolve() read the (unlocked) row. Re-read the live
        // value so the client doesn't regress to a stale count.
        const fresh = await prisma.feedbackItem.findFirst({
          where: { id: feedbackId, orgId },
          select: { voteCount: true },
        });
        if (fresh) voteCount = fresh.voteCount;
      } else {
        throw e; // re-throw anything that isn't "already voted"
      }
    }

    return success({ voteCount, hasVoted: true });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const r = await resolve(orgId, feedbackId);
    if (r.error) return r.error;
    const { ctx } = r;

    let voteCount = r.item.voteCount;
    let result: { voteCount: number } | null;
    try {
      result = await prisma.$transaction(async (tx) => {
        await lockUnmerged(tx, feedbackId);
        const deleted = await tx.feedbackVote.deleteMany({
          where: { feedbackItemId: feedbackId, userId: ctx.userId },
        });
        if (deleted.count === 0) return null; // wasn't voting — no change
        // A row was deleted, so it had previously been counted via POST's
        // unconditional increment — decrementing by 1 (computed atomically by
        // Postgres against the live value) can't go negative and is symmetric
        // with POST. (Using the stale pre-tx count here would drift the total.)
        return tx.feedbackItem.update({
          where: { id: feedbackId },
          data: { voteCount: { decrement: 1 } },
          select: { voteCount: true },
        });
      });
    } catch (e) {
      if (e instanceof MergedMeanwhile) return mergedResponse(e.mergedIntoId);
      throw e;
    }
    if (result) voteCount = result.voteCount;

    return success({ voteCount, hasVoted: false });
  } catch (e) {
    return handleApiError(e);
  }
}
