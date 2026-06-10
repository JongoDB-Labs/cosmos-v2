import { NextRequest } from "next/server";
import { z } from "zod";
import { FeedbackType, FeedbackStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
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

    return success(items.map((i) => ({ ...i, hasVoted: voted.has(i.id) })));
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  type: z.nativeEnum(FeedbackType).default(FeedbackType.FEATURE),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).default(""),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ); // any member may submit feedback

    const data = createSchema.parse(await request.json());

    const created = await prisma.feedbackItem.create({
      data: {
        orgId,
        authorId: ctx.userId,
        type: data.type,
        title: data.title,
        description: data.description,
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
