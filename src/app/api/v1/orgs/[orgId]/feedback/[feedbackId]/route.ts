import { NextRequest } from "next/server";
import { z } from "zod";
import { FeedbackStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/rbac/check";
import { FEEDBACK_ROW_SELECT, toFeedbackDto } from "@/lib/feedback/feedback-dto";
import { FEEDBACK_SUBJECT } from "@/lib/feedback/subject";
import { inVisibleProject } from "@/lib/rbac/require-project-read";

type RouteParams = { params: Promise<{ orgId: string; feedbackId: string }> };

const updateSchema = z.object({
  // MERGED is set only by a merge, never by hand.
  status: z
    .nativeEnum(FeedbackStatus)
    .refine((s) => s !== "MERGED", "MERGED is set by merging, not by changing the status")
    .optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
});

/**
 * One feedback item, for the board's `?item=` deep link: a notification can
 * point at an item that is not in the list's top 200. Same per-viewer shape and
 * the same ORG_READ gate as the list.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const item = await prisma.feedbackItem.findFirst({
      where: { id: feedbackId, orgId },
      select: {
        ...FEEDBACK_ROW_SELECT,
        projectId: true,
        attachments: {
          select: { id: true, kind: true, url: true, filename: true, contentType: true, size: true },
        },
      },
    });
    // A team-scoped project's feedback is the same 404 as a missing one.
    if (!item || !(await inVisibleProject(ctx, item.projectId))) return new Response("Not found", { status: 404 });

    const [vote, author] = await Promise.all([
      prisma.feedbackVote.findFirst({
        where: { userId: ctx.userId, feedbackItemId: item.id },
        select: { feedbackItemId: true },
      }),
      prisma.user.findUnique({
        where: { id: item.authorId },
        select: { displayName: true, email: true },
      }),
    ]);

    return success({
      ...toFeedbackDto(
        item,
        { userId: ctx.userId, isStaff: hasPermission(ctx.permissions, Permission.ORG_UPDATE) },
        author,
      ),
      attachments: item.attachments,
      hasVoted: vote !== null,
    });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.feedbackItem.findFirst({
      where: { id: feedbackId, orgId },
    });
    if (!existing || !(await inVisibleProject(ctx, existing.projectId))) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());

    const isAuthor = existing.authorId === ctx.userId;
    const wantsContentEdit =
      data.title !== undefined || data.description !== undefined;
    const wantsStatusChange = data.status !== undefined;

    // Two distinct authorities, gated independently so each applies only when
    // the request actually exercises it:
    //  - Status triage is an admin action. Resource-aware authz: ORG_UPDATE in
    //    the bitfield AND any deny policy referencing it, with the author mapped
    //    authorId→createdById for owns_resource narrowing. Identical to
    //    requirePermission until a policy exists.
    //  - Editing the title/description is owned by the author OR an admin: the
    //    author can edit their own words WITHOUT ORG_UPDATE (so a member can
    //    update the FR/BR they filed), and an admin (ORG_UPDATE) may edit ANY
    //    member's item (COSMOS-49). A non-author without ORG_UPDATE is refused
    //    with a clear, user-facing reason the portal surfaces verbatim.
    if (wantsStatusChange) {
      await requireAccess(ctx, "ORG_UPDATE", {
        createdById: existing.authorId,
      });
      // A merged item's status belongs to the merge. Changing it here would
      // un-hide the item while it still points at its survivor (and its merge
      // record still says merged), so it is refused until the merge is undone.
      if (existing.mergedIntoId || existing.status === "MERGED") {
        return new Response(
          JSON.stringify({
            error: "This request was merged into another one. Undo the merge to change its status.",
            mergedIntoId: existing.mergedIntoId,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    if (wantsContentEdit && !isAuthor) {
      if (!hasPermission(ctx.permissions, Permission.ORG_UPDATE)) {
        return new Response(
          JSON.stringify({
            error: "Only the author or an admin can edit the title or description",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      // Admin path routes through the same resource-aware gate as status triage
      // and delete, so any deny policy an org later authors applies uniformly.
      await requireAccess(ctx, "ORG_UPDATE", {
        createdById: existing.authorId,
      });
    }

    const updated = await prisma.feedbackItem.update({
      where: { id: feedbackId },
      data: {
        ...(data.status !== undefined && { status: data.status }),
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
      },
      select: FEEDBACK_ROW_SELECT,
    });

    // Explicit per-viewer shape — never the raw row (see feedback-dto.ts). An
    // author editing their own item must not get the triage reasoning back.
    const author = await prisma.user.findUnique({
      where: { id: updated.authorId },
      select: { displayName: true, email: true },
    });
    return success(
      toFeedbackDto(
        updated,
        { userId: ctx.userId, isStaff: hasPermission(ctx.permissions, Permission.ORG_UPDATE) },
        author,
      ),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.feedbackItem.findFirst({
      where: { id: feedbackId, orgId },
    });
    if (!existing || !(await inVisibleProject(ctx, existing.projectId))) return new Response("Not found", { status: 404 });

    // Author can delete their own; admins can delete any. Defense-in-depth:
    // keep the author bypass, but route the admin branch through resource-aware
    // authz (ORG_UPDATE in the bitfield AND any deny policy referencing it,
    // with the feedback author mapped authorId→createdById for owns_resource
    // narrowing). Identical to requirePermission until a policy exists.
    const isAuthor = existing.authorId === ctx.userId;
    if (!isAuthor) {
      await requireAccess(ctx, "ORG_UPDATE", {
        createdById: existing.authorId,
      });
    }

    // Comment has no FK to feedback_items (it is polymorphic), so the item's
    // discussion and the backlinks it created go with it explicitly.
    await prisma.$transaction(async (tx) => {
      const comments = await tx.comment.findMany({
        where: { orgId, subjectType: FEEDBACK_SUBJECT, subjectId: feedbackId },
        select: { id: true },
      });
      if (comments.length > 0) {
        await tx.reference.deleteMany({
          where: { orgId, sourceType: "comment", sourceId: { in: comments.map((c) => c.id) } },
        });
        await tx.comment.deleteMany({ where: { orgId, subjectType: FEEDBACK_SUBJECT, subjectId: feedbackId } });
      }
      await tx.feedbackItem.delete({ where: { id: feedbackId } });
    });

    return success({ id: feedbackId });
  } catch (e) {
    return handleApiError(e);
  }
}
