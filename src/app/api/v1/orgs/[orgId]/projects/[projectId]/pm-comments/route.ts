import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { createNotification } from "@/lib/notifications/create";
import { parseMentions } from "@/lib/chat/mentions";
import { resolvePmSubject, isPmSubjectType } from "@/lib/pm/subjects";
import { logPmActivity } from "@/lib/pm/activity-log";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.COMMENT_READ);

    const { searchParams } = new URL(request.url);
    const subjectType = searchParams.get("subjectType") ?? "";
    const subjectId = searchParams.get("subjectId") ?? "";
    if (!isPmSubjectType(subjectType) || !subjectId)
      return new Response("Bad request", { status: 400 });

    const subject = await resolvePmSubject(subjectType, subjectId, orgId, projectId);
    if (!subject) return new Response("Not found", { status: 404 });

    const comments = await prisma.comment.findMany({
      where: { orgId, subjectType, subjectId },
      orderBy: { createdAt: "asc" },
    });

    const authorIds = [...new Set(comments.map((c) => c.authorId))];
    const authors = authorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, displayName: true, avatarUrl: true },
        })
      : [];
    const authorById = new Map(authors.map((u) => [u.id, u]));
    const isManager = await canManageProject(ctx, projectId);

    return success(
      comments.map((c) => ({
        id: c.id,
        content: c.content,
        authorId: c.authorId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        authorName: authorById.get(c.authorId)?.displayName ?? null,
        authorAvatarUrl: authorById.get(c.authorId)?.avatarUrl ?? null,
        canEdit: c.authorId === ctx.userId,
        canDelete: c.authorId === ctx.userId || isManager,
      })),
    );
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  subjectType: z.string(),
  subjectId: z.string().uuid(),
  content: z.string().min(1).max(10000),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "COMMENT_CREATE", { createdById: ctx.userId, projectId });

    const data = createSchema.parse(await request.json());
    if (!isPmSubjectType(data.subjectType)) return new Response("Bad request", { status: 400 });

    const subject = await resolvePmSubject(data.subjectType, data.subjectId, orgId, projectId);
    if (!subject) return new Response("Not found", { status: 404 });

    const comment = await prisma.comment.create({
      data: {
        orgId,
        subjectType: data.subjectType,
        subjectId: data.subjectId,
        authorId: ctx.userId,
        content: data.content,
      },
    });
    await logPmActivity({
      orgId,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      userId: ctx.userId,
      action: "commented",
    });

    // Mention fan-out (best-effort) — same <@uuid> parser as work items.
    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { key: true },
      });
      const url = `/${org.slug}/projects/${project?.key ?? projectId}/pm-dashboard/${subject.urlSeg}`;
      const label = subject.code ? `${subject.code} ${subject.title}` : subject.title;
      const mentioned = parseMentions(comment.content ?? "");
      if (mentioned.length > 0) {
        const valid = await prisma.orgMember.findMany({
          where: { orgId, userId: { in: mentioned } },
          select: { userId: true },
        });
        for (const m of valid) {
          if (m.userId === ctx.userId) continue;
          await createNotification({
            orgId,
            userId: m.userId,
            type: "comment.mentioned",
            title: `Mentioned on ${label}`,
            message: (comment.content ?? "").replace(/<@[0-9a-f-]{36}>/gi, "@user").slice(0, 200),
            relatedId: data.subjectId,
            relatedType: `pm_${data.subjectType}`,
            url,
          }).catch(() => {});
        }
      }
    } catch {
      /* swallow */
    }

    return created(comment);
  } catch (error) {
    return handleApiError(error);
  }
}
