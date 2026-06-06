import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { safeEmbedText } from "@/lib/rag/embed";
import { Visibility, Prisma } from "@prisma/client";
import { z } from "zod";
import { assertPermission, loadActorPermissions, type ToolContext } from "./_ctx";

const createNoteSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().optional(),
  visibility: z.nativeEnum(Visibility).optional(),
  // `projectId` is accepted for forward-compat / context but cosmos's Note
  // model has no projectId column today; we ignore it silently.
  projectId: z.string().uuid().optional(),
});

const updateNoteSchema = z.object({
  noteId: z.string().uuid(),
  title: z.string().max(500).optional(),
  content: z.string().optional(),
  visibility: z.nativeEnum(Visibility).optional(),
});

const deleteNoteSchema = z.object({
  noteId: z.string().uuid(),
});

export async function createNote(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.NOTE_CREATE);
  if (denied) return denied;

  const parsed = createNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const note = await prisma.note.create({
    data: {
      orgId: ctx.orgId,
      authorId: ctx.userId,
      title: data.title,
      content: data.content ?? "",
      visibility: data.visibility ?? Visibility.PRIVATE,
    },
  });

  // RAG: embed-on-write — see src/app/api/v1/orgs/[orgId]/notes/route.ts.
  const sv = await safeEmbedText(`${note.title}\n${note.content}`);
  if (sv) {
    await prisma.note
      .update({
        where: { id: note.id },
        data: { searchVector: sv as unknown as Prisma.InputJsonValue },
      })
      .catch(() => {
        /* best-effort — don't break the tool response on embedding failure */
      });
  }

  return {
    created: true,
    id: note.id,
    title: note.title,
    visibility: note.visibility,
  };
}

export async function updateNote(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.NOTE_UPDATE);
  if (denied) return denied;

  const parsed = updateNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const existing = await prisma.note.findFirst({
    where: { id: data.noteId, orgId: ctx.orgId },
  });
  if (!existing) return { error: "Note not found" };
  if (existing.authorId !== ctx.userId) {
    return { error: "Only the author can update this note" };
  }

  const note = await prisma.note.update({
    where: { id: data.noteId },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.content !== undefined && { content: data.content }),
      ...(data.visibility !== undefined && { visibility: data.visibility }),
    },
  });

  if (data.title !== undefined || data.content !== undefined) {
    const sv = await safeEmbedText(`${note.title}\n${note.content}`);
    if (sv) {
      await prisma.note
        .update({
          where: { id: note.id },
          data: { searchVector: sv as unknown as Prisma.InputJsonValue },
        })
        .catch(() => {
          /* best-effort */
        });
    }
  }

  return { updated: true, id: note.id, title: note.title, visibility: note.visibility };
}

export async function deleteNote(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.NOTE_DELETE);
  if (denied) return denied;

  const parsed = deleteNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }

  const existing = await prisma.note.findFirst({
    where: { id: parsed.data.noteId, orgId: ctx.orgId },
  });
  if (!existing) return { error: "Note not found" };

  if (existing.authorId !== ctx.userId) {
    const actor = await loadActorPermissions(ctx);
    const isPrivileged = actor?.orgRole === "OWNER" || actor?.orgRole === "ADMIN";
    if (!isPrivileged) {
      return { error: "Only the author or an admin can delete this note" };
    }
  }

  await prisma.note.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id, title: existing.title };
}
