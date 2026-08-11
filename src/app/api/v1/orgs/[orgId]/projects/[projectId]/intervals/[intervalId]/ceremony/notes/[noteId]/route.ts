import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { success, handleApiError } from "@/lib/api-helpers";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { z } from "zod";
import {
  requireContributor,
  isResponse,
  publishCeremonyChanged,
} from "../../_helpers";

type RouteParams = {
  params: Promise<{
    orgId: string;
    projectId: string;
    intervalId: string;
    noteId: string;
  }>;
};

const patchSchema = z.object({ text: z.string().trim().min(1).max(2000) });

/**
 * Load a note and prove it belongs to this org, project and sprint — routes
 * address notes by their own ID, so without the join a note from another
 * tenant's ceremony would be reachable here.
 */
async function loadNote(
  noteId: string,
  scope: { orgId: string; projectId: string; intervalId: string }
) {
  return prisma.retroNote.findFirst({
    where: {
      id: noteId,
      ceremony: {
        orgId: scope.orgId,
        intervalId: scope.intervalId,
        board: { projectId: scope.projectId },
      },
    },
    select: {
      id: true,
      authorId: true,
      ceremonyId: true,
      ceremony: { select: { status: true } },
    },
  });
}

/**
 * Editing and deleting are the AUTHOR's, with the facilitator able to remove
 * anything — someone must be able to take down what should not have been
 * written, and the person who wrote it may have left the room.
 */
async function mayModify(
  ctx: AuthContext,
  projectId: string,
  authorId: string | null
): Promise<boolean> {
  if (authorId && authorId === ctx.userId) return true;
  try {
    await requireProjectManage(ctx, projectId, Permission.SPRINT_COMPLETE);
    return true;
  } catch {
    return false;
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId, noteId } = await params;
    const loaded = await requireContributor(orgId, projectId, intervalId);
    if (isResponse(loaded)) return loaded;
    const { ctx } = loaded;

    const note = await loadNote(noteId, { orgId, projectId, intervalId });
    if (!note) return new Response("Note not found", { status: 404 });
    if (note.ceremony.status === "CLOSED") {
      return new Response(
        JSON.stringify({ error: "This ceremony is closed" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    if (!(await mayModify(ctx, projectId, note.authorId))) {
      return new Response("Forbidden", { status: 403 });
    }

    const data = patchSchema.parse(await request.json());
    const updated = await prisma.retroNote.update({
      where: { id: note.id },
      data: { text: data.text },
    });

    publishCeremonyChanged(orgId, note.ceremonyId);
    return success({ id: updated.id, text: updated.text });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId, noteId } = await params;
    const loaded = await requireContributor(orgId, projectId, intervalId);
    if (isResponse(loaded)) return loaded;
    const { ctx } = loaded;

    const note = await loadNote(noteId, { orgId, projectId, intervalId });
    if (!note) return new Response("Note not found", { status: 404 });
    if (!(await mayModify(ctx, projectId, note.authorId))) {
      return new Response("Forbidden", { status: 403 });
    }

    await prisma.retroNote.delete({ where: { id: note.id } });
    publishCeremonyChanged(orgId, note.ceremonyId);
    return success({ id: note.id });
  } catch (e) {
    return handleApiError(e);
  }
}
