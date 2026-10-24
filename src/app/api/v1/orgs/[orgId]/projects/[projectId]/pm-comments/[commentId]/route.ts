import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { canManageProject } from "@/lib/rbac/scope";
import { success, handleApiError } from "@/lib/api-helpers";
import { Permission } from "@/lib/rbac/permissions";
import { resolvePmSubject } from "@/lib/pm/subjects";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; commentId: string }>;
};

const updateSchema = z.object({ content: z.string().min(1).max(10000) });

/**
 * The register comment, when its subject is in the path's project. The gates
 * judge that project (read access, manager moderation), so a comment on
 * another project's risk or change must not be reachable by naming this one.
 */
async function commentInProject(orgId: string, projectId: string, commentId: string) {
  const comment = await prisma.comment.findFirst({ where: { id: commentId, orgId } });
  if (!comment?.subjectType || !comment.subjectId) return null;
  return (await resolvePmSubject(comment.subjectType, comment.subjectId, orgId, projectId)) ? comment : null;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, commentId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Editing or removing a comment is a write: a session needs COMMENT_READ
    // plus authorship, as ever; a key also needs COMMENT_CREATE (items:write),
    // so a read key can't rewrite or erase what its minter published.
    await requireProjectRead(ctx, projectId, ctx.isApiKey ? "COMMENT_CREATE" : "COMMENT_READ");

    const existing = await commentInProject(orgId, projectId, commentId);
    if (!existing) return new Response("Not found", { status: 404 });
    if (existing.authorId !== ctx.userId) return new Response("Forbidden", { status: 403 }); // edit = author only

    const data = updateSchema.parse(await request.json());
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
    const { orgId, projectId, commentId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Editing or removing a comment is a write: a session needs COMMENT_READ
    // plus authorship, as ever; a key also needs COMMENT_CREATE (items:write),
    // so a read key can't rewrite or erase what its minter published.
    await requireProjectRead(ctx, projectId, ctx.isApiKey ? "COMMENT_CREATE" : "COMMENT_READ");

    const existing = await commentInProject(orgId, projectId, commentId);
    if (!existing) return new Response("Not found", { status: 404 });

    const isManager = await canManageProject(ctx, projectId, Permission.ITEM_DELETE);
    if (existing.authorId !== ctx.userId && !isManager)
      return new Response("Forbidden", { status: 403 });

    await prisma.comment.delete({ where: { id: commentId } });
    return success({ id: commentId });
  } catch (error) {
    return handleApiError(error);
  }
}
