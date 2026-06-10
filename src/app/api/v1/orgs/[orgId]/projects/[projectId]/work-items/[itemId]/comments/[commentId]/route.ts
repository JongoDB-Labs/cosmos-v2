import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { success, noContent, handleApiError } from "@/lib/api-helpers";
import { z } from "zod";

/**
 * Edit / delete a single work-item comment — the CRUD the comments collection
 * route lacked (posted comments were immutable + unremovable). There is no
 * COMMENT_UPDATE/DELETE permission bit, so we gate on OWNERSHIP, mirroring the
 * chat-message own-content pattern: edit is author-only; delete is the author OR
 * a project manager (moderation). COMMENT_READ is the membership baseline.
 */

const updateCommentSchema = z.object({ content: z.string().min(1).max(10000) });

type RouteParams = {
  params: Promise<{
    orgId: string;
    projectId: string;
    itemId: string;
    commentId: string;
  }>;
};

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId, commentId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.COMMENT_READ);

    const existing = await prisma.comment.findFirst({
      where: { id: commentId, orgId, workItemId: itemId },
    });
    if (!existing) return new Response("Not found", { status: 404 });
    // Editing is author-only — you can only change your own words.
    if (existing.authorId !== ctx.userId) {
      return new Response("Forbidden", { status: 403 });
    }

    const data = updateCommentSchema.parse(await request.json());
    const updated = await prisma.comment.update({
      where: { id: commentId },
      data: { content: data.content },
    });
    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId, commentId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.COMMENT_READ);

    const existing = await prisma.comment.findFirst({
      where: { id: commentId, orgId, workItemId: itemId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // The author can remove their own comment; a project manager can moderate.
    const allowed =
      existing.authorId === ctx.userId ||
      (await canManageProject(ctx, projectId));
    if (!allowed) return new Response("Forbidden", { status: 403 });

    await prisma.comment.delete({ where: { id: commentId } });
    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
