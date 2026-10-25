import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { requireAccess } from "@/lib/abac/require-access";
import { handleApiError } from "@/lib/api-helpers";
import { createNotification } from "@/lib/notifications/create";
import { mentionsToPlainText, userMentionLabels } from "@/lib/mentions/plain-text";
import { publishToOrg } from "@/lib/realtime/broker";
import { parseMentions } from "@/lib/chat/mentions";
import { syncReferences } from "@/lib/mentions/references";
import { z } from "zod";
import { loadWorkItemComments } from "@/lib/work-items/read.server";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem, ProblemError } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { CommentWrite } from "@/lib/openapi/schemas/work-item-actions";
import { createWorkItemComment, listWorkItemComments } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; itemId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listWorkItemComments);
    const { params: { orgId, projectId, itemId } } = await parseRequest(listWorkItemComments, request, params);
    await requireProjectRead(ctx, projectId, "COMMENT_READ");

    const comments = await loadWorkItemComments(ctx, orgId, projectId, itemId);
    if (!comments) return problem(404, "not_found", undefined, { request });
    return respond(listWorkItemComments, 200, comments);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await orgContext((await params).orgId, createWorkItemComment);
    const { params: ids, body } = await parseRequest(createWorkItemComment, request, params);
    return respond(createWorkItemComment, 201, await createComment(org, ctx, ids, body));
  } catch (error) {
    return handleApiError(error, request);
  }
}

/**
 * Post a comment as `ctx`, with its notifications and live update. Shared with
 * the org-scoped `/work-items/{itemId}/comments`, which resolves the project.
 */
export async function createComment(
  org: { id: string; slug: string },
  ctx: AuthContext,
  ids: { orgId: string; projectId: string; itemId: string },
  data: z.infer<typeof CommentWrite>,
) {
  const { orgId, projectId, itemId } = ids;
  await requireProjectVisible(ctx, projectId);

  // Resource-aware authz: COMMENT_CREATE in the bitfield AND any deny policy
  // referencing it. The actor authors the comment, so map author→createdById;
  // projectId enables in_project deny narrowing. Identical to
  // requirePermission until a policy exists.
  await requireAccess(ctx, "COMMENT_CREATE", {
    createdById: ctx.userId,
    projectId,
  });

  const item = await prisma.workItem.findFirst({ where: { id: itemId, orgId, projectId } });
  if (!item) throw new ProblemError(404, "not_found");

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

  // Live updates (COSMOS-127): a new comment (including a Foreman console
  // Approve / Rework, which post on this same route) refreshes any open board,
  // issues list, ticket thread, and the Foreman console's event feed without a
  // manual refresh. Best-effort — a broker error never breaks the POST.
  try {
    publishToOrg(orgId, "work-item.updated", {
      id: itemId,
      projectId,
      ticketNumber: item.ticketNumber,
    });
  } catch {
    /* never let a broker error break the comment response */
  }

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
      // displayName rides along on the query that already runs to decide the
      // fan-out, so resolving the snippet below costs no extra round trip.
      const validInOrg = await prisma.orgMember.findMany({
        where: { orgId, userId: { in: mentionedAll } },
        select: { userId: true, user: { select: { displayName: true } } },
      });
      mentionedUserIds = new Set(validInOrg.map((m) => m.userId));
      mentionedUserIds.delete(ctx.userId);
      const mentionLabels = userMentionLabels(
        validInOrg
          .filter((m) => m.user?.displayName)
          .map((m) => ({ id: m.userId, displayName: m.user!.displayName })),
      );

      for (const recipientId of mentionedUserIds) {
        await createNotification({
          orgId,
          userId: recipientId,
          type: "comment.mentioned",
          title: `Mentioned in ${workItem.title}`,
          message: mentionsToPlainText(comment.content ?? "", mentionLabels).slice(0, 200),
          relatedId: workItem.id,
          relatedType: "work_item",
          // COSMOS-191. There is no /projects/[projectKey]/work-items/[id]
          // route — not under [orgSlug], not anywhere, and no catch-all. Every
          // form of that path 404s, which is what the reporter hit. The app's
          // real work-item deep link is /[orgSlug]/issues?item=<id> (see
          // issue-copy-link and 6 other call sites); issues-view.tsx reads it
          // with searchParams.get("item").
          url: `/${org.slug}/issues?item=${workItem.id}`,
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
        message: mentionsToPlainText(comment.content ?? "").slice(0, 200),
        relatedId: workItem.id,
        relatedType: "work_item",
        url: `/${org.slug}/issues?item=${workItem.id}`,
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
  // actor IS the author, read by id: an API key has no session user to ask.
  // The per-actor CRUD flags are always true for the author.
  const author = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { displayName: true, avatarUrl: true },
  });
  return {
    ...comment,
    authorName: author?.displayName ?? null,
    authorAvatarUrl: author?.avatarUrl ?? null,
    canEdit: true,
    canDelete: true,
  };
}
