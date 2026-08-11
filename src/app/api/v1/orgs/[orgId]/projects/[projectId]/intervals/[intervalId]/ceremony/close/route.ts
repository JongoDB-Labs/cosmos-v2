import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import {
  requireFacilitator,
  isResponse,
  loadCeremony,
  publishCeremonyChanged,
} from "../_helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; intervalId: string }>;
};

const bodySchema = z.object({ ceremonyId: z.string().uuid() });

/**
 * Close the ceremony. This is a real event, not a view: a CLOSED row with a
 * `closedAt` is what distinguishes "we held this retro" from "nobody ever
 * opened the board", and no derived figure can tell those apart.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const loaded = await requireFacilitator(orgId, projectId, intervalId);
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
        JSON.stringify({ error: "This ceremony is already closed" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    const updated = await prisma.sprintCeremony.update({
      where: { id: ceremony.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "ceremony.close",
      entity: "SprintCeremony",
      entityId: ceremony.id,
      metadata: { intervalId, kind: ceremony.kind },
      ipAddress: getIpAddress(request),
    });
    publishCeremonyChanged(orgId, ceremony.id);

    return success({
      id: updated.id,
      status: updated.status,
      closedAt: updated.closedAt,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
