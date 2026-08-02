import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { z } from "zod";
import {
  assertPermission,
  assertProjectRead,
  loadActorPermissions,
  type ToolContext,
} from "./_ctx";

const addCommentSchema = z.object({
  workItemId: z.string().uuid(),
  content: z.string().min(1).max(10_000),
});

const listCommentsSchema = z.object({
  workItemId: z.string().uuid(),
});

const deleteCommentSchema = z.object({
  commentId: z.string().uuid(),
});

export async function addComment(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.COMMENT_CREATE);
  if (denied) return denied;

  const parsed = addCommentSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const { workItemId, content } = parsed.data;

  const item = await prisma.workItem.findFirst({
    where: { id: workItemId, orgId: ctx.orgId },
    select: { id: true, projectId: true },
  });
  if (!item) return { error: "Work item not found" };

  // Commenting on a ticket in a project you cannot open both writes into that
  // project's record and confirms the ticket exists. Same message as a genuine
  // miss, so a refusal reveals nothing.
  const outOfScope = await assertProjectRead(ctx, item.projectId, "COMMENT_CREATE");
  if (outOfScope) return { error: "Work item not found" };

  const [comment] = await prisma.$transaction([
    prisma.comment.create({
      data: {
        orgId: ctx.orgId,
        workItemId,
        authorId: ctx.userId,
        content,
      },
    }),
    prisma.activity.create({
      data: {
        orgId: ctx.orgId,
        workItemId,
        userId: ctx.userId,
        action: "commented",
      },
    }),
  ]);

  return {
    created: true,
    id: comment.id,
    workItemId: comment.workItemId,
    contentPreview: comment.content.slice(0, 200),
  };
}

export async function listComments(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.COMMENT_READ);
  if (denied) return denied;

  const parsed = listCommentsSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }

  const item = await prisma.workItem.findFirst({
    where: { id: parsed.data.workItemId, orgId: ctx.orgId },
    select: { id: true, projectId: true },
  });
  if (!item) return { error: "Work item not found" };

  // COMMENT_READ is held by MEMBER and VIEWER, and the org check above only
  // proves the ticket EXISTS — so this handed back the discussion on any ticket
  // in the org, including projects with `teamScopedAccess` the asker is not a
  // member of. Comments are usually the most candid thing attached to a ticket,
  // which makes this the worst place to skip the check.
  //
  // Reported as "Work item not found", NOT as a project error: telling the two
  // apart would confirm the ticket exists inside a project they cannot open.
  const outOfScope = await assertProjectRead(ctx, item.projectId, "COMMENT_READ");
  if (outOfScope) return { error: "Work item not found" };

  const comments = await prisma.comment.findMany({
    where: { workItemId: parsed.data.workItemId, orgId: ctx.orgId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      authorId: true,
      content: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return { count: comments.length, comments };
}

export async function deleteComment(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  // No dedicated COMMENT_DELETE permission — gate on COMMENT_CREATE plus an
  // author/admin check below, matching the pattern used for notes.
  const denied = await assertPermission(ctx, Permission.COMMENT_CREATE);
  if (denied) return denied;

  const parsed = deleteCommentSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }

  const existing = await prisma.comment.findFirst({
    where: { id: parsed.data.commentId, orgId: ctx.orgId },
  });
  if (!existing) return { error: "Comment not found" };

  // A comment inherits its scope from the ticket it hangs off. Without this a
  // non-member could DELETE discussion on a project closed to them.
  // `workItemId` is NULLABLE — a comment not attached to a ticket has no
  // project to inherit scope from, and the org check is all there is.
  if (existing.workItemId) {
    const parentItem = await prisma.workItem.findFirst({
      where: { id: existing.workItemId, orgId: ctx.orgId },
      select: { projectId: true },
    });
    if (!parentItem) return { error: "Comment not found" };
    const outOfScope = await assertProjectRead(ctx, parentItem.projectId, "COMMENT_CREATE");
    if (outOfScope) return { error: "Comment not found" };
  }

  if (existing.authorId !== ctx.userId) {
    const actor = await loadActorPermissions(ctx);
    const isPrivileged = actor?.orgRole === "OWNER" || actor?.orgRole === "ADMIN";
    if (!isPrivileged) {
      return { error: "Only the author or an admin can delete this comment" };
    }
  }

  await prisma.comment.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id };
}
