import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { success, handleApiError } from "@/lib/api-helpers";
import { z } from "zod";
import {
  requireContributor,
  isResponse,
  loadCeremony,
  publishCeremonyChanged,
} from "../_helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; intervalId: string }>;
};

const bodySchema = z.object({
  ceremonyId: z.string().uuid(),
  columnKey: z.string().min(1),
  text: z.string().trim().min(1).max(2000),
});

/**
 * Add a note to a retro column. Any project member may — a retro only the
 * facilitator can type into is theatre.
 *
 * The author is recorded but the read path withholds it unless the board opts
 * in, so a person can delete their own note without the room seeing who wrote
 * what.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const loaded = await requireContributor(orgId, projectId, intervalId);
    if (isResponse(loaded)) return loaded;
    const { ctx } = loaded;

    const data = bodySchema.parse(await request.json());
    const ceremony = await loadCeremony(data.ceremonyId, {
      orgId,
      projectId,
      intervalId,
    });
    if (!ceremony) return new Response("Ceremony not found", { status: 404 });

    if (ceremony.status === "CLOSED") {
      return new Response(
        JSON.stringify({ error: "This ceremony is closed. Reopen it to add notes." }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // The column must be one this board actually has, or a note lands in a
    // column nothing renders and simply disappears.
    const column = await prisma.boardColumn.findFirst({
      where: { boardId: ceremony.boardId, key: data.columnKey },
      select: { key: true },
    });
    if (!column) {
      return new Response(
        JSON.stringify({ error: "That column is not on this board" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const max = await prisma.retroNote.aggregate({
      where: { ceremonyId: ceremony.id, columnKey: data.columnKey },
      _max: { sortOrder: true },
    });

    const note = await prisma.retroNote.create({
      data: {
        ceremonyId: ceremony.id,
        columnKey: data.columnKey,
        text: data.text,
        authorId: ctx.userId,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
      },
    });

    publishCeremonyChanged(orgId, ceremony.id);

    return success({
      id: note.id,
      columnKey: note.columnKey,
      text: note.text,
      isMine: true,
      createdAt: note.createdAt,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
