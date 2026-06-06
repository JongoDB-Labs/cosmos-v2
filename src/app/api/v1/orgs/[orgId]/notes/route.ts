import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { safeEmbedText } from "@/lib/rag/embed";
import { parseMentions } from "@/lib/chat/mentions";
import { createNotification } from "@/lib/notifications/create";
import { z } from "zod";
import { Visibility, Prisma } from "@prisma/client";

const createNoteSchema = z.object({
  title: z.string().min(1, "Title is required").max(500),
  content: z.string().nullish(),
  visibility: z.nativeEnum(Visibility).default(Visibility.PRIVATE),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.NOTE_READ);

    const visibility = request.nextUrl.searchParams.get("visibility");

    const where: Record<string, unknown> = { orgId };

    if (visibility === "PRIVATE") {
      where.visibility = "PRIVATE";
      where.authorId = ctx.userId;
    } else if (visibility === "ORG" || visibility === "PROJECT") {
      where.visibility = visibility;
    } else {
      // Show private notes only for the author, plus all org/project notes
      where.OR = [
        { visibility: "PRIVATE", authorId: ctx.userId },
        { visibility: { in: ["ORG", "PROJECT"] } },
      ];
    }

    const notes = await prisma.note.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    return success(notes);
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
    requirePermission(ctx, Permission.NOTE_CREATE);

    const body = await request.json();
    const data = createNoteSchema.parse(body);

    const note = await prisma.note.create({
      data: {
        orgId,
        authorId: ctx.userId,
        title: data.title ?? "",
        content: data.content ?? "",
        visibility: data.visibility,
      },
    });

    // RAG: embed-on-write. Best-effort — a tokenizer failure must not break
    // the user-facing POST response. TODO(rag): move to an async job queue
    // once we have one; embedding on the request path is fine while it's a
    // cheap token-bag operation but won't be once we swap to a real model.
    {
      const text = `${note.title}\n${note.content}`;
      const sv = await safeEmbedText(text);
      if (sv) {
        await prisma.note
          .update({
            where: { id: note.id },
            data: { searchVector: sv as unknown as Prisma.InputJsonValue },
          })
          .catch((err: unknown) =>
            console.warn("[rag] failed to persist note embedding:", (err as Error).message)
          );
      }
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "note.created",
      entity: "note",
      entityId: note.id,
      metadata: { title: data.title ?? "", visibility: data.visibility } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Mention notifications — best-effort, must not fail the response.
    try {
      const mentionedIds = parseMentions(note.content);
      if (mentionedIds.length > 0) {
        const validMembers = await prisma.orgMember.findMany({
          where: { orgId, userId: { in: mentionedIds } },
          select: { userId: true },
        });
        const recipients = new Set(validMembers.map((m) => m.userId));
        recipients.delete(ctx.userId);

        const snippet = note.content
          .replace(/<@[0-9a-f-]{36}>/gi, "@user")
          .slice(0, 200);

        for (const recipientId of recipients) {
          await createNotification({
            orgId,
            userId: recipientId,
            type: "note.mentioned",
            title: `Mentioned in ${note.title || "a note"}`,
            message: snippet,
            relatedId: note.id,
            relatedType: "note",
            url: `/notes/${note.id}`,
          }).catch(() => { /* swallow */ });
        }
      }
    } catch {
      /* notifications are best-effort */
    }

    return created(note);
  } catch (error) {
    return handleApiError(error);
  }
}
