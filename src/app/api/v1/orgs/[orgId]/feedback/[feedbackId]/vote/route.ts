import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

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
  return { ctx, item };
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
        await tx.feedbackVote.create({
          data: { feedbackItemId: feedbackId, userId: ctx.userId },
        });
        return tx.feedbackItem.update({
          where: { id: feedbackId },
          data: { voteCount: { increment: 1 } },
          select: { voteCount: true },
        });
      });
      voteCount = result.voteCount;
    } catch (e) {
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
    const result = await prisma.$transaction(async (tx) => {
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
    if (result) voteCount = result.voteCount;

    return success({ voteCount, hasVoted: false });
  } catch (e) {
    return handleApiError(e);
  }
}
