import type { Note } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { hasPermission, Permission } from "@/lib/rbac/permissions";

/**
 * May this person read the note: NOTE_READ, and for a private note, being its
 * author. A note belongs to no project, so a PROJECT note reads like an ORG one
 * (the list, export, search and Cosmo's tools filter the same way).
 *
 * The note's own GET answers a note this refuses with 404, and a mention in a
 * note is sent only to someone this allows (createNotification), so a notice
 * never carries a note's text to someone who couldn't open it.
 */
export function canReadNote(ctx: Pick<AuthContext, "userId" | "permissions">, note: Pick<Note, "visibility" | "authorId">): boolean {
  if (!hasPermission(ctx.permissions, Permission.NOTE_READ)) return false;
  return note.visibility !== "PRIVATE" || note.authorId === ctx.userId;
}
