import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { storeEmbedding } from "@/lib/rag/embed";
import { parseMentions } from "@/lib/chat/mentions";
import { syncReferences } from "@/lib/mentions/references";
import { createNotification } from "@/lib/notifications/create";
import { z } from "zod";
import { Visibility } from "@prisma/client";

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

    // RAG: embed-on-write. Best-effort — an embedding failure must not break
    // the user-facing POST response. Runs AFTER the row is committed.
    // TODO(rag): move to an async job queue once we have one; embedding a real
    // model on the request path is acceptable for now (CPU MiniLM, ~tens of ms).
    await storeEmbedding("notes", note.id, `${note.title}\n${note.content}`).catch(
      (err: unknown) =>
        console.warn("[rag] failed to persist note embedding:", (err as Error).message)
    );

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

    // Record @-entity backlinks — best-effort.
    void syncReferences({
      orgId,
      sourceType: "note",
      sourceId: note.id,
      content: note.content,
      createdById: ctx.userId,
    }).catch(() => {});

    return created(note);
  } catch (error) {
    return handleApiError(error);
  }
}
