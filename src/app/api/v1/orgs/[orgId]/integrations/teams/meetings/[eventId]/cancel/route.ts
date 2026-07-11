import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { cancelTeamsMeeting } from "@/lib/integrations/teams-meetings";

type RouteParams = { params: Promise<{ orgId: string; eventId: string }> };

/** See the collection route — 409 for a not-linked tenant, 502 for other Graph errors. */
function graphErrorStatus(error: string): number {
  return /not connected/i.test(error) ? 409 : 502;
}

const cancelSchema = z.object({
  organizer: z.string().min(1, "An organizer (M365 user id or UPN) is required"),
  comment: z.string().optional(),
});

/**
 * Cancel a Teams meeting on the linked tenant (COSMOS-48) — Graph marks the event
 * cancelled and notifies attendees with the optional comment. Gated on MEETING_UPDATE.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, eventId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_UPDATE);

    const body = (await request.json().catch(() => ({}))) as unknown;
    const input = cancelSchema.parse(body);

    const result = await cancelTeamsMeeting(orgId, {
      organizer: input.organizer,
      eventId,
      comment: input.comment,
    });
    if (!result.ok) return success({ error: result.error }, graphErrorStatus(result.error));

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "teams_meeting.cancelled",
      entity: "teams_meeting",
      entityId: eventId,
      ipAddress: getIpAddress(request),
    });

    return success({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
