import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { CeremonyKind } from "@prisma/client";
import { z } from "zod";
import {
  requireFacilitator,
  isResponse,
  publishCeremonyChanged,
} from "../_helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; intervalId: string }>;
};

const bodySchema = z.object({
  boardId: z.string().uuid(),
  kind: z.nativeEnum(CeremonyKind),
});

/**
 * Open the ceremony for this board and sprint, creating it if this is the first
 * time. Idempotent: re-opening a RUNNING ceremony returns the same row rather
 * than a second one, which the (boardId, intervalId) unique index also enforces
 * at the database.
 *
 * Re-opening a CLOSED ceremony is allowed and deliberate — a team that closed
 * early and wants to add one more action should not have to lose the retro.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const loaded = await requireFacilitator(orgId, projectId, intervalId);
    if (isResponse(loaded)) return loaded;
    const { ctx } = loaded;

    const data = bodySchema.parse(await request.json());

    // Prove the board and sprint are this project's before writing a row that
    // joins them.
    const [board, interval] = await Promise.all([
      prisma.board.findFirst({
        where: { id: data.boardId, projectId },
        select: { id: true },
      }),
      prisma.interval.findFirst({
        where: { id: intervalId, orgId, projectId },
        select: { id: true },
      }),
    ]);
    if (!board) return new Response("Board not found", { status: 404 });
    if (!interval) return new Response("Interval not found", { status: 404 });

    const ceremony = await prisma.sprintCeremony.upsert({
      where: {
        boardId_intervalId: { boardId: data.boardId, intervalId },
      },
      create: {
        orgId,
        boardId: data.boardId,
        intervalId,
        kind: data.kind,
        status: "RUNNING",
      },
      update: { status: "RUNNING", closedAt: null },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "ceremony.open",
      entity: "SprintCeremony",
      entityId: ceremony.id,
      metadata: { boardId: data.boardId, intervalId, kind: data.kind },
      ipAddress: getIpAddress(request),
    });
    publishCeremonyChanged(orgId, ceremony.id);

    return success({
      id: ceremony.id,
      kind: ceremony.kind,
      status: ceremony.status,
      closedAt: ceremony.closedAt,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
