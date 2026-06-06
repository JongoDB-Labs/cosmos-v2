import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updateConversationSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  archived: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; conversationId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, conversationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CHAT_USE);

    const conversation = await prisma.assistantConversation.findFirst({
      where: { id: conversationId, orgId, userId: ctx.userId },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!conversation) return new Response("Not found", { status: 404 });

    return success(conversation);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, conversationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CHAT_USE);

    const existing = await prisma.assistantConversation.findFirst({
      where: { id: conversationId, orgId, userId: ctx.userId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateConversationSchema.parse(body);

    const updated = await prisma.assistantConversation.update({
      where: { id: conversationId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.archived !== undefined && { archived: data.archived }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "chat.conversation.updated",
      entity: "assistantConversation",
      entityId: conversationId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, conversationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CHAT_USE);

    const existing = await prisma.assistantConversation.findFirst({
      where: { id: conversationId, orgId, userId: ctx.userId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.assistantConversation.delete({ where: { id: conversationId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "chat.conversation.deleted",
      entity: "assistantConversation",
      entityId: conversationId,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
