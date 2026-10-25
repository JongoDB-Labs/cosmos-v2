import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createConversationSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  /** Created out of the list from the start — a walkthrough's temporary
   *  conversation is the caller's own but not part of their history. */
  archived: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CHAT_USE);

    // Archived conversations are out of the list unless asked for. Archiving
    // in the assistant panel only hid one until the next load, when this
    // returned it again.
    const includeArchived = request.nextUrl.searchParams.get("archived") === "true";
    const conversations = await prisma.assistantConversation.findMany({
      where: { orgId, userId: ctx.userId, ...(includeArchived ? {} : { archived: false }) },
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { messages: true } },
      },
    });

    return success(conversations);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CHAT_USE);

    const body = await request.json();
    const data = createConversationSchema.parse(body);

    const conversation = await prisma.assistantConversation.create({
      data: {
        orgId,
        userId: ctx.userId,
        title: data.title ?? "New conversation",
        ...(data.archived !== undefined && { archived: data.archived }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "chat.conversation.created",
      entity: "assistantConversation",
      entityId: conversation.id,
      ipAddress: getIpAddress(request),
    });

    return created(conversation);
  } catch (error) {
    return handleApiError(error);
  }
}
