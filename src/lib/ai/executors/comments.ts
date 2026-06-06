import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { z } from "zod";
import { assertPermission, loadActorPermissions, type ToolContext } from "./_ctx";

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
    select: { id: true },
  });
  if (!item) return { error: "Work item not found" };

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
    select: { id: true },
  });
  if (!item) return { error: "Work item not found" };

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
