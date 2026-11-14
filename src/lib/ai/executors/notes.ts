import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { storeEmbedding } from "@/lib/rag/embed";
import { Visibility } from "@prisma/client";
import { z } from "zod";
import { assertPermission, loadAuthContext, type ToolContext } from "./_ctx";
import { roleCountsFor } from "@/lib/rbac/key-role";

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

const shareNoteSchema = z.object({
  noteId: z.string().uuid(),
  visibility: z.nativeEnum(Visibility),
});

/**
 * Who a visibility lets in, as a rank: PRIVATE is its author alone, and each
 * step up lets more people read it. A move UP the ranks is a widening.
 *
 * Cosmo makes a note visible to more people only through `share_note`, which
 * is confirm-class: the agent loop shows the user a preview and waits for
 * their yes (confirmation.ts). Anything that reads a note's text is a way to
 * instruct the model, so a note that says "make my notes public" must not be
 * able to do it on the model's word. `create_note` therefore always saves
 * private and `update_note` refuses to widen; narrowing, or leaving it as it
 * is, takes effect at once. Same split as `create_saved_view` and
 * `share_saved_view`.
 */
const VISIBILITY_RANK: Record<Visibility, number> = {
  [Visibility.PRIVATE]: 0,
  [Visibility.PROJECT]: 1,
  [Visibility.ORG]: 2,
};
const widens = (from: Visibility, to: Visibility) => VISIBILITY_RANK[to] > VISIBILITY_RANK[from];

const listNotesSchema = z.object({
  visibility: z.nativeEnum(Visibility).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

/**
 * The notes READ the agent did not have.
 *
 * `create_note`, `update_note` and `delete_note` all shipped; nothing could
 * list or fetch one. The writes take a `noteId`, so two of the three were
 * unusable in practice — there was no way for the model to learn an id. Same
 * shape as `get_work_item`: a write surface with no read behind it.
 *
 * THE VISIBILITY RULE IS THE WHOLE RISK HERE. `Note.visibility` is PRIVATE by
 * default (see `createNote` above), and a naive org-scoped list would hand every
 * member everybody else's private notes. `GET /notes` narrows it, and this
 * FORWARDS that clause rather than restating it:
 *
 *   - PRIVATE  → only the caller's own
 *   - ORG/PROJECT → anyone holding NOTE_READ
 *   - unfiltered  → the OR of those two
 *
 * `content` is deliberately NOT returned. A note body is free text, excluded
 * from `EXPOSABLE_FIELDS` and therefore dropped on a withheld tenant anyway;
 * returning it here would be a bulk dump of prose into a list answer. A future
 * `get_note` can return one body at a time, which is the pattern
 * `get_work_item` settled on for the same reason.
 */
export async function listNotes(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.NOTE_READ);
  if (denied) return denied;

  const parsed = listNotesSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const { visibility, limit } = parsed.data;

  // Mirrors GET /notes exactly; see the docblock for why this cannot be a
  // plain org scope.
  const where: Record<string, unknown> = { orgId: ctx.orgId };
  if (visibility === Visibility.PRIVATE) {
    where.visibility = Visibility.PRIVATE;
    where.authorId = ctx.userId;
  } else if (visibility === Visibility.ORG || visibility === Visibility.PROJECT) {
    where.visibility = visibility;
  } else {
    where.OR = [
      { visibility: Visibility.PRIVATE, authorId: ctx.userId },
      { visibility: { in: [Visibility.ORG, Visibility.PROJECT] } },
    ];
  }

  const notes = await prisma.note.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit ?? 50,
    // No `content`: see the docblock.
    select: {
      id: true, title: true, visibility: true, authorId: true,
      createdAt: true, updatedAt: true,
    },
  });

  return { count: notes.length, notes };
}

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
  const { visibility: asked, ...data } = parsed.data;

  // Always private: sharing is share_note, which waits for the user's yes (see
  // VISIBILITY_RANK). A visibility the model sends anyway is read only to say
  // what was not done.
  const note = await prisma.note.create({
    data: {
      orgId: ctx.orgId,
      authorId: ctx.userId,
      title: data.title,
      content: data.content ?? "",
      visibility: Visibility.PRIVATE,
    },
  });

  // RAG: embed-on-write — see src/app/api/v1/orgs/[orgId]/notes/route.ts.
  // Runs AFTER the row exists; best-effort so an embed failure never breaks the tool.
  await storeEmbedding("notes", note.id, `${note.title}\n${note.content}`).catch(() => {
    /* best-effort — don't break the tool response on embedding failure */
  });

  return {
    created: true,
    id: note.id,
    title: note.title,
    visibility: note.visibility,
    // Enums at the top level, so the model learns this even where results are withheld.
    ...(asked !== undefined && asked !== Visibility.PRIVATE && {
      requestedVisibility: asked,
      nextStep: "share_note",
      note: "Saved as private. Sharing it is a separate step the user confirms: call share_note with this id.",
    }),
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
  // Refused whole, so a rename asked for beside it doesn't half-happen.
  if (data.visibility !== undefined && widens(existing.visibility, data.visibility)) {
    return {
      error:
        "Letting more people see a note needs the user's yes: call share_note with this noteId and visibility. Nothing was changed.",
      requestedVisibility: data.visibility,
      nextStep: "share_note",
    };
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
    await storeEmbedding("notes", note.id, `${note.title}\n${note.content}`).catch(() => {
      /* best-effort */
    });
  }

  return { updated: true, id: note.id, title: note.title, visibility: note.visibility };
}

/**
 * Change who sees a note — the one way Cosmo lets more people see it.
 * Confirm-class (see VISIBILITY_RANK): the agent loop runs it only after the
 * user has answered a preview. The same gate as `update_note`: NOTE_UPDATE,
 * and only the note's author.
 */
export async function shareNote(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.NOTE_UPDATE);
  if (denied) return denied;

  const parsed = shareNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const { noteId, visibility } = parsed.data;

  const existing = await prisma.note.findFirst({ where: { id: noteId, orgId: ctx.orgId } });
  if (!existing) return { error: "Note not found" };
  if (existing.authorId !== ctx.userId) {
    return { error: "Only the author can change who sees this note" };
  }

  const note = await prisma.note.update({ where: { id: noteId }, data: { visibility } });
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
    const actor = await loadAuthContext(ctx);
    // A key acts as an admin only when its scopes grant NOTE_DELETE (rbac/key-role.ts).
    const isPrivileged =
      (actor?.orgRole === "OWNER" || actor?.orgRole === "ADMIN") && roleCountsFor(actor, Permission.NOTE_DELETE);
    if (!isPrivileged) {
      return { error: "Only the author or an admin can delete this note" };
    }
  }

  await prisma.note.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id, title: existing.title };
}
