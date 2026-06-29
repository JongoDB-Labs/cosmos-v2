import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { Permission } from "@/lib/rbac/permissions";
import { requirePermission } from "@/lib/rbac/check";
import { canManageProject } from "@/lib/rbac/scope";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; commentId: string }>;
};

const updateSchema = z.object({ content: z.string().min(1).max(10000) });

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, commentId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.COMMENT_READ);

    const existing = await prisma.comment.findFirst({ where: { id: commentId, orgId } });
    if (!existing || !existing.subjectType) return new Response("Not found", { status: 404 });
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
    requirePermission(ctx, Permission.COMMENT_READ);

    const existing = await prisma.comment.findFirst({ where: { id: commentId, orgId } });
    if (!existing || !existing.subjectType) return new Response("Not found", { status: 404 });

    const isManager = await canManageProject(ctx, projectId);
    if (existing.authorId !== ctx.userId && !isManager)
      return new Response("Forbidden", { status: 403 });

    await prisma.comment.delete({ where: { id: commentId } });
    return success({ id: commentId });
  } catch (error) {
    return handleApiError(error);
  }
}
