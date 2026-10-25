import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { canManageProject } from "@/lib/rbac/scope";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem, ProblemError } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { deleteWorkItemComment, updateWorkItemComment } from "./route.contract";
import { Permission } from "@/lib/rbac/permissions";

/**
 * Edit / delete a single work-item comment — the CRUD the comments collection
 * route lacked (posted comments were immutable + unremovable). There is no
 * COMMENT_UPDATE/DELETE permission bit, so we gate on OWNERSHIP, mirroring the
 * chat-message own-content pattern: edit is author-only; delete is the author OR
 * a project manager (moderation). COMMENT_READ is the membership baseline.
 */

type RouteParams = {
  params: Promise<{
    orgId: string;
    projectId: string;
    itemId: string;
    commentId: string;
  }>;
};

/**
 * The comment, if it is on the path's item and that item is in the path's
 * project: the gates judge that project, so a comment on another project's
 * item is not this route's.
 */
async function findComment(ids: { orgId: string; projectId: string; itemId: string; commentId: string }) {
  const { orgId, projectId, itemId, commentId } = ids;
  const existing = await prisma.comment.findFirst({
    where: { id: commentId, orgId, workItemId: itemId, workItem: { projectId } },
  });
  if (!existing) throw new ProblemError(404, "not_found");
  return existing;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, updateWorkItemComment);
    const { params: ids, body } = await parseRequest(updateWorkItemComment, request, params);
    // Editing or removing a comment is a write: a session needs COMMENT_READ
    // plus authorship, as ever; a key also needs COMMENT_CREATE (items:write),
    // so a read key can't rewrite or erase what its minter published.
    await requireProjectRead(ctx, ids.projectId, ctx.isApiKey ? "COMMENT_CREATE" : "COMMENT_READ");

    const existing = await findComment(ids);
    // Editing is author-only — you can only change your own words.
    if (existing.authorId !== ctx.userId) {
      return problem(403, "forbidden", "Only the comment's author can edit it", { request });
    }

    const updated = await prisma.comment.update({
      where: { id: ids.commentId },
      data: { content: body.content },
    });
    return respond(updateWorkItemComment, 200, updated);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, deleteWorkItemComment);
    const { params: ids } = await parseRequest(deleteWorkItemComment, request, params);
    await requireProjectRead(ctx, ids.projectId, ctx.isApiKey ? "COMMENT_CREATE" : "COMMENT_READ");

    const existing = await findComment(ids);
    // The author can remove their own comment; a project manager can moderate.
    const allowed =
      existing.authorId === ctx.userId ||
      (await canManageProject(ctx, ids.projectId, Permission.ITEM_DELETE));
    if (!allowed) return problem(403, "forbidden", "Only the comment's author or a project manager can delete it", { request });

    await prisma.comment.delete({ where: { id: ids.commentId } });
    return respond(deleteWorkItemComment, 204, null);
  } catch (error) {
    return handleApiError(error, request);
  }
}
