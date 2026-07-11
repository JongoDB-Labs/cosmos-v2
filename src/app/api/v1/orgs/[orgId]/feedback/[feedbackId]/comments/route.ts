import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { success, created, handleApiError } from "@/lib/api-helpers";

// Feedback comments attach to the polymorphic Comment model (the same
// (subjectType, subjectId) mechanism PM registers and other surfaces use), so
// no new table/migration is needed. This constant is the discriminator — it's
// NOT a PmSubjectType, so PM comment routes (which gate on isPmSubjectType)
// never resolve or mutate these rows.
const SUBJECT_TYPE = "feedback";

type RouteParams = { params: Promise<{ orgId: string; feedbackId: string }> };

/** Auth + existence gate shared by GET/POST. Any org member (ORG_READ) may
 *  read and post comments — same authority the portal uses for voting and
 *  submitting, so "other users can comment as well as vote" holds. */
async function resolve(orgId: string, feedbackId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  requirePermission(ctx, Permission.ORG_READ);
  const item = await prisma.feedbackItem.findFirst({
    where: { id: feedbackId, orgId },
    select: { id: true },
  });
  if (!item) return { error: new Response("Not found", { status: 404 }) };
  return { ctx };
}

/** Enrich a comment row with author display fields + the caller's permissions
 *  over it, so the client can render + gate the delete control without a second
 *  round-trip. The lean User select never touches OrgMember.permissions. */
async function serialize(
  comments: { id: string; content: string; authorId: string; createdAt: Date; updatedAt: Date }[],
  callerId: string,
  callerCanManage: boolean,
) {
  const authorIds = [...new Set(comments.map((c) => c.authorId))];
  const authors = authorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, displayName: true, email: true, avatarUrl: true },
      })
    : [];
  const byId = new Map(authors.map((u) => [u.id, u]));
  return comments.map((c) => ({
    id: c.id,
    content: c.content,
    authorId: c.authorId,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    authorName: byId.get(c.authorId)?.displayName ?? null,
    authorEmail: byId.get(c.authorId)?.email ?? null,
    authorAvatarUrl: byId.get(c.authorId)?.avatarUrl ?? null,
    // The author can always delete their own comment; a manager (ORG_UPDATE)
    // can moderate any. Mirrors the DELETE handler's authorization exactly.
    canDelete: c.authorId === callerId || callerCanManage,
  }));
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const r = await resolve(orgId, feedbackId);
    if (r.error) return r.error;
    const { ctx } = r;

    const comments = await prisma.comment.findMany({
      where: { orgId, subjectType: SUBJECT_TYPE, subjectId: feedbackId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        content: true,
        authorId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const canManage = hasPermission(ctx.permissions, Permission.ORG_UPDATE);
    return success(await serialize(comments, ctx.userId, canManage));
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  content: z.string().trim().min(1).max(5000),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const r = await resolve(orgId, feedbackId);
    if (r.error) return r.error;
    const { ctx } = r;

    // Throttle to keep a member from spamming the thread (same shape as the
    // feedback-submit limiter).
    const limited = checkRateLimit(request, "feedback.comment", ctx.userId, {
      capacity: 20,
      refillPerSecond: 0.5,
    });
    if (limited) return limited;

    const data = createSchema.parse(await request.json());

    const row = await prisma.comment.create({
      data: {
        orgId,
        subjectType: SUBJECT_TYPE,
        subjectId: feedbackId,
        authorId: ctx.userId,
        content: data.content,
      },
      select: {
        id: true,
        content: true,
        authorId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const canManage = hasPermission(ctx.permissions, Permission.ORG_UPDATE);
    const [serialized] = await serialize([row], ctx.userId, canManage);
    return created(serialized);
  } catch (e) {
    return handleApiError(e);
  }
}
