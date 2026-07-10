import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { createNotification } from "@/lib/notifications/create";
import { parseMentions } from "@/lib/chat/mentions";
import { syncReferences } from "@/lib/mentions/references";
import { z } from "zod";

const createCommentSchema = z.object({
  content: z.string().min(1).max(10000),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string; itemId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.COMMENT_READ);

    const item = await prisma.workItem.findFirst({ where: { id: itemId, orgId, projectId } });
    if (!item) return new Response("Not found", { status: 404 });

    const comments = await prisma.comment.findMany({
      where: { workItemId: itemId, orgId },
      orderBy: { createdAt: "asc" },
    });

    // Resolve author display names (Comment has no User relation) + per-comment
    // CRUD flags so the UI can show edit (author-only) / delete (author or a
    // project manager) affordances. A side query keeps this migration-free and
    // never touches OrgMember.permissions (BigInt).
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
        ...c,
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

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // Resource-aware authz: COMMENT_CREATE in the bitfield AND any deny policy
    // referencing it. The actor authors the comment, so map author→createdById;
    // projectId enables in_project deny narrowing. Identical to
    // requirePermission until a policy exists.
    await requireAccess(ctx, "COMMENT_CREATE", {
      createdById: ctx.userId,
      projectId,
    });

    const item = await prisma.workItem.findFirst({ where: { id: itemId, orgId, projectId } });
    if (!item) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = createCommentSchema.parse(body);

    const [comment] = await prisma.$transaction([
      prisma.comment.create({
        data: {
          orgId,
          workItemId: itemId,
          authorId: ctx.userId,
          content: data.content,
        },
      }),
      prisma.activity.create({
        data: {
          orgId,
          workItemId: itemId,
          userId: ctx.userId,
          action: "commented",
        },
      }),
    ]);

    // ── Notification fan-out ────────────────────────────────────────────
    try {
      const workItem = await prisma.workItem.findFirst({
        where: { id: itemId, orgId },
        select: {
          id: true,
          title: true,
          assigneeId: true,
          projectId: true,
        },
      });
      const projectKey = workItem
        ? await prisma.project
            .findUnique({
              where: { id: workItem.projectId },
              select: { key: true },
            })
            .then((p) => p?.key ?? workItem.projectId)
            .catch(() => workItem.projectId)
        : projectId;

      // 1. Parse <@uuid> mentions out of the comment body (Phase 2: unified parser)
      const mentionedAll = parseMentions(comment.content ?? "");
      let mentionedUserIds = new Set<string>();
      if (mentionedAll.length > 0 && workItem) {
        const validInOrg = await prisma.orgMember.findMany({
          where: { orgId, userId: { in: mentionedAll } },
          select: { userId: true },
        });
        mentionedUserIds = new Set(validInOrg.map((m) => m.userId));
        mentionedUserIds.delete(ctx.userId);

        for (const recipientId of mentionedUserIds) {
          await createNotification({
            orgId,
            userId: recipientId,
            type: "comment.mentioned",
            title: `Mentioned in ${workItem.title}`,
            message: (comment.content ?? "")
              .replace(/<@[0-9a-f-]{36}>/gi, "@user")
              .slice(0, 200),
            relatedId: workItem.id,
            relatedType: "work_item",
            url: `/projects/${projectKey}/work-items/${workItem.id}`,
          }).catch(() => {
            /* swallow */
          });
        }
      }

      // 2. Notify the work-item assignee on any new comment, unless they
      //    posted it OR were already notified above via mention.
      if (
        workItem?.assigneeId &&
        workItem.assigneeId !== ctx.userId &&
        !mentionedUserIds.has(workItem.assigneeId)
      ) {
        await createNotification({
          orgId,
          userId: workItem.assigneeId,
          type: "comment.added",
          title: `New comment on ${workItem.title}`,
          message: (comment.content ?? "").slice(0, 200),
          relatedId: workItem.id,
          relatedType: "work_item",
          url: `/${org.slug}/projects/${projectKey}/work-items/${workItem.id}`,
        }).catch(() => {
          /* swallow */
        });
      }
    } catch {
      /* swallow — notifications are best-effort */
    }

    // Record @-entity backlinks — best-effort. Person mentions handled above.
    void syncReferences({
      orgId,
      sourceType: "comment",
      sourceId: comment.id,
      content: comment.content ?? "",
      createdById: ctx.userId,
    }).catch(() => {});

    // Enrich the response so the client can render the author immediately —
    // mirrors the GET shape. Without this the freshly-posted comment has no
    // resolved name and the UI falls back to "Unknown" until a refetch. The
    // actor IS the author, so name/avatar come from the (memoized) current user
    // and the per-actor CRUD flags are always true for them.
    const author = await getCurrentUser();
    return created({
      ...comment,
      authorName: author?.displayName ?? null,
      authorAvatarUrl: author?.avatarUrl ?? null,
      canEdit: true,
      canDelete: true,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
