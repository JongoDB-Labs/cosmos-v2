import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { safeEmbedText } from "@/lib/rag/embed";
import { parseMentions } from "@/lib/chat/mentions";
import { createNotification } from "@/lib/notifications/create";
import { z } from "zod";
import { Visibility, Prisma } from "@prisma/client";

const updateNoteSchema = z.object({
  title: z.string().max(500).nullish(),
  content: z.string().nullish(),
  visibility: z.nativeEnum(Visibility).optional(),
});

type RouteParams = { params: Promise<{ orgId: string; noteId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, noteId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.NOTE_READ);

    const note = await prisma.note.findFirst({
      where: { id: noteId, orgId },
    });

    if (!note) return new Response("Not found", { status: 404 });

    // Enforce visibility: private notes only visible to author
    if (note.visibility === "PRIVATE" && note.authorId !== ctx.userId) {
      return new Response("Not found", { status: 404 });
    }

    return success(note);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, noteId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.note.findFirst({
      where: { id: noteId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: checks NOTE_UPDATE in the bitfield AND applies any
    // work-role/member deny policy that references it (narrowing by ownership).
    // Note.authorId is the owner → map to createdById so owns_resource binds.
    // Identical to requirePermission until a policy exists.
    await requireAccess(ctx, "NOTE_UPDATE", { createdById: existing.authorId });

    // Only author can update (defense-in-depth)
    if (existing.authorId !== ctx.userId) {
      return new Response(
        JSON.stringify({ error: "Only the author can update this note" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json();
    const data = updateNoteSchema.parse(body);

    const updated = await prisma.note.update({
      where: { id: noteId },
      data: {
        ...(data.title !== undefined && { title: data.title ?? "" }),
        ...(data.content !== undefined && { content: data.content ?? "" }),
        ...(data.visibility !== undefined && { visibility: data.visibility }),
      },
    });

    // RAG: re-embed only when the searchable text actually changed. Avoids
    // wasted work when callers PUT just a visibility flip.
    if (data.title !== undefined || data.content !== undefined) {
      const sv = await safeEmbedText(`${updated.title}\n${updated.content}`);
      if (sv) {
        await prisma.note
          .update({
            where: { id: noteId },
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
      action: "note.updated",
      entity: "note",
      entityId: noteId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Mention notifications — only fire for newly-added mentions to avoid
    // re-notifying people who were already mentioned in prior saves.
    if (data.content !== undefined) {
      try {
        const newMentions = new Set(parseMentions(updated.content));
        const oldMentions = new Set(parseMentions(existing.content));
        const added = [...newMentions].filter((id) => !oldMentions.has(id));

        if (added.length > 0) {
          const validMembers = await prisma.orgMember.findMany({
            where: { orgId, userId: { in: added } },
            select: { userId: true },
          });
          const recipients = new Set(validMembers.map((m) => m.userId));
          recipients.delete(ctx.userId);

          const snippet = updated.content
            .replace(/<@[0-9a-f-]{36}>/gi, "@user")
            .slice(0, 200);

          for (const recipientId of recipients) {
            await createNotification({
              orgId,
              userId: recipientId,
              type: "note.mentioned",
              title: `Mentioned in ${updated.title || "a note"}`,
              message: snippet,
              relatedId: noteId,
              relatedType: "note",
              url: `/notes/${noteId}`,
            }).catch(() => { /* swallow */ });
          }
        }
      } catch {
        /* notifications are best-effort */
      }
    }

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, noteId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.note.findFirst({
      where: { id: noteId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz (NOTE_DELETE + any narrowing deny policy). Note.authorId
    // is the owner → map to createdById so owns_resource binds.
    await requireAccess(ctx, "NOTE_DELETE", { createdById: existing.authorId });

    // Only author or admin/owner can delete (defense-in-depth)
    const isAdminOrOwner = ctx.orgRole === "ADMIN" || ctx.orgRole === "OWNER";
    if (existing.authorId !== ctx.userId && !isAdminOrOwner) {
      return new Response(
        JSON.stringify({ error: "Only the author or an admin can delete this note" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    await prisma.note.delete({ where: { id: noteId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "note.deleted",
      entity: "note",
      entityId: noteId,
      metadata: { title: existing.title } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
