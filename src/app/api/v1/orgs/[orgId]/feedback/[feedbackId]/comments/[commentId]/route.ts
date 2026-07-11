import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

// Same discriminator the list/create route writes — a comment is only
// deletable through this route if it actually belongs to this feedback item.
const SUBJECT_TYPE = "feedback";

type RouteParams = {
  params: Promise<{ orgId: string; feedbackId: string; commentId: string }>;
};

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId, commentId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    // Scope the lookup to this org + feedback item so a comment id from another
    // item (or a foreign org) 404s rather than being deletable here.
    const existing = await prisma.comment.findFirst({
      where: { id: commentId, orgId, subjectType: SUBJECT_TYPE, subjectId: feedbackId },
      select: { id: true, authorId: true },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Author can delete their own; a manager can moderate any. Mirrors the
    // feedback-item DELETE: author bypass, else resource-aware ORG_UPDATE.
    if (existing.authorId !== ctx.userId) {
      await requireAccess(ctx, "ORG_UPDATE", { createdById: existing.authorId });
    }

    await prisma.comment.delete({ where: { id: commentId } });
    return success({ id: commentId });
  } catch (e) {
    return handleApiError(e);
  }
}
