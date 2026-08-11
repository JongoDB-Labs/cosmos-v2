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
  text: z.string().trim().min(1).max(2000),
  ownerId: z.string().uuid().nullish(),
  dueDate: z.coerce.date().nullish(),
});

/**
 * Capture an action item. Owner and due date are optional at this point on
 * purpose: an action is typed mid-conversation, and demanding both before the
 * row exists stops the conversation. The board nags for them afterwards, and
 * promotion needs them.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const loaded = await requireContributor(orgId, projectId, intervalId);
    if (isResponse(loaded)) return loaded;

    const data = bodySchema.parse(await request.json());
    const ceremony = await loadCeremony(data.ceremonyId, {
      orgId,
      projectId,
      intervalId,
    });
    if (!ceremony) return new Response("Ceremony not found", { status: 404 });
    if (ceremony.status === "CLOSED") {
      return new Response(
        JSON.stringify({ error: "This ceremony is closed. Reopen it to add actions." }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // An owner must be a member of this org, or the action is assigned to
    // somebody who will never see it.
    if (data.ownerId) {
      const member = await prisma.orgMember.findFirst({
        where: { orgId, userId: data.ownerId },
        select: { id: true },
      });
      if (!member) {
        return new Response(
          JSON.stringify({ error: "That owner is not a member of this organization" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const max = await prisma.retroActionItem.aggregate({
      where: { ceremonyId: ceremony.id },
      _max: { sortOrder: true },
    });

    const action = await prisma.retroActionItem.create({
      data: {
        ceremonyId: ceremony.id,
        text: data.text,
        ownerId: data.ownerId ?? null,
        dueDate: data.dueDate ?? null,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
      },
    });

    publishCeremonyChanged(orgId, ceremony.id);
    return success(action);
  } catch (e) {
    return handleApiError(e);
  }
}
