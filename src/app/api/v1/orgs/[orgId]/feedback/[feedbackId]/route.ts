import { NextRequest } from "next/server";
import { z } from "zod";
import { FeedbackStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; feedbackId: string }> };

const updateSchema = z.object({
  status: z.nativeEnum(FeedbackStatus).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
});

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.feedbackItem.findFirst({
      where: { id: feedbackId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Triaging (status changes) is an admin action. Resource-aware authz:
    // ORG_UPDATE in the bitfield AND any deny policy referencing it. The
    // feedback author is the owner, so map authorId→createdById for
    // owns_resource narrowing. Identical to requirePermission until a policy
    // exists.
    await requireAccess(ctx, "ORG_UPDATE", {
      createdById: existing.authorId,
    });

    const data = updateSchema.parse(await request.json());

    // ORG_UPDATE confers status triage. Editing the title/description is
    // author-owned — an admin triaging shouldn't be able to rewrite a member's
    // words.
    const wantsContentEdit =
      data.title !== undefined || data.description !== undefined;
    if (wantsContentEdit && existing.authorId !== ctx.userId) {
      return new Response(
        JSON.stringify({
          error: "Only the author can edit the title or description",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    const updated = await prisma.feedbackItem.update({
      where: { id: feedbackId },
      data: {
        ...(data.status !== undefined && { status: data.status }),
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
      },
    });

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, feedbackId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.feedbackItem.findFirst({
      where: { id: feedbackId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Author can delete their own; admins can delete any. Defense-in-depth:
    // keep the author bypass, but route the admin branch through resource-aware
    // authz (ORG_UPDATE in the bitfield AND any deny policy referencing it,
    // with the feedback author mapped authorId→createdById for owns_resource
    // narrowing). Identical to requirePermission until a policy exists.
    const isAuthor = existing.authorId === ctx.userId;
    if (!isAuthor) {
      await requireAccess(ctx, "ORG_UPDATE", {
        createdById: existing.authorId,
      });
    }

    await prisma.feedbackItem.delete({ where: { id: feedbackId } });

    return success({ id: feedbackId });
  } catch (e) {
    return handleApiError(e);
  }
}
