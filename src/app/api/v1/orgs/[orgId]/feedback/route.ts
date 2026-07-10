import { NextRequest } from "next/server";
import { z } from "zod";
import { FeedbackType, FeedbackStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const querySchema = z.object({
      type: z.nativeEnum(FeedbackType).optional(),
      status: z.nativeEnum(FeedbackStatus).optional(),
    });
    const { type, status } = querySchema.parse({
      type: request.nextUrl.searchParams.get("type") ?? undefined,
      status: request.nextUrl.searchParams.get("status") ?? undefined,
    });

    const items = await prisma.feedbackItem.findMany({
      where: { orgId, ...(type ? { type } : {}), ...(status ? { status } : {}) },
      orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
      take: 200,
      include: {
        attachments: {
          select: { id: true, kind: true, url: true, filename: true, contentType: true, size: true },
        },
      },
    });

    // Annotate each item with whether the current user has voted.
    const myVotes = items.length
      ? await prisma.feedbackVote.findMany({
          where: { userId: ctx.userId, feedbackItemId: { in: items.map((i) => i.id) } },
          select: { feedbackItemId: true },
        })
      : [];
    const voted = new Set(myVotes.map((v) => v.feedbackItemId));

    // Resolve submitter display names (FeedbackItem has no User relation — same
    // migration-free side-query pattern as work-item comments) so the portal can
    // show "Reported by <name>", falling back to email. A lean select — never
    // touches OrgMember.permissions (BigInt).
    const authorIds = [...new Set(items.map((i) => i.authorId))];
    const authors = authorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, displayName: true, email: true },
        })
      : [];
    const authorById = new Map(authors.map((u) => [u.id, u]));

    return success(
      items.map((i) => ({
        ...i,
        hasVoted: voted.has(i.id),
        authorName: authorById.get(i.authorId)?.displayName ?? null,
        authorEmail: authorById.get(i.authorId)?.email ?? null,
      })),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  type: z.nativeEnum(FeedbackType).default(FeedbackType.FEATURE),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).default(""),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
  // Which project this feedback is about (app-level, optional — the portal is
  // an org-level surface with no implicit "current project"). Validated below
  // against THIS org's live projects; null/omitted stays app-wide.
  projectId: z.string().uuid().nullable().optional(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ); // any member may submit feedback

    // Throttle submissions (consistency with chat/export) — prevents an
    // authenticated member from spamming the feedback board.
    const limited = checkRateLimit(request, "feedback.submit", ctx.userId, {
      capacity: 10,
      refillPerSecond: 0.2,
    });
    if (limited) return limited;

    const data = createSchema.parse(await request.json());

    // A provided projectId must belong to THIS org and be a live (non-archived)
    // project — cross-org / archived / bogus ids are a 400, not a silent drop.
    if (data.projectId) {
      const project = await prisma.project.findFirst({
        where: { id: data.projectId, orgId, archived: false },
        select: { id: true },
      });
      if (!project) return new Response("Invalid project", { status: 400 });
    }

    const created = await prisma.feedbackItem.create({
      data: {
        orgId,
        authorId: ctx.userId,
        type: data.type,
        title: data.title,
        description: data.description,
        projectId: data.projectId ?? null,
      },
    });

    // Link the submitter's own orphan attachments to the new item.
    let attachments: {
      id: string;
      kind: string;
      url: string;
      filename: string;
      contentType: string;
      size: number;
    }[] = [];
    if (data.attachmentIds?.length) {
      await prisma.feedbackAttachment.updateMany({
        where: {
          id: { in: data.attachmentIds },
          orgId,
          feedbackItemId: null,
          uploadedById: ctx.userId,
        },
        data: { feedbackItemId: created.id },
      });
      attachments = await prisma.feedbackAttachment.findMany({
        where: { feedbackItemId: created.id },
        select: { id: true, kind: true, url: true, filename: true, contentType: true, size: true },
      });
    }

    return success({ ...created, hasVoted: false, attachments });
  } catch (e) {
    return handleApiError(e);
  }
}
