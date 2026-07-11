import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import {
  updateTeamsMeetingAttendees,
  deleteTeamsMeeting,
} from "@/lib/integrations/teams-meetings";

type RouteParams = { params: Promise<{ orgId: string; eventId: string }> };

/** See the collection route — 409 for a not-linked tenant, 502 for other Graph errors. */
function graphErrorStatus(error: string): number {
  return /not connected/i.test(error) ? 409 : 502;
}

const attendeeSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  type: z.enum(["required", "optional"]).optional(),
});

const updateSchema = z.object({
  organizer: z.string().min(1, "An organizer (M365 user id or UPN) is required"),
  // The FULL desired attendee set — omitted attendees are removed, new ones invited.
  attendees: z.array(attendeeSchema),
});

/**
 * Invite/remove attendees on an existing Teams meeting on the linked tenant
 * (COSMOS-48). Pass the full desired attendee set. Gated on MEETING_UPDATE.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, eventId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_UPDATE);

    const body = await request.json();
    const input = updateSchema.parse(body);

    const result = await updateTeamsMeetingAttendees(orgId, {
      organizer: input.organizer,
      eventId,
      attendees: input.attendees,
    });
    if (!result.ok) return success({ error: result.error }, graphErrorStatus(result.error));

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "teams_meeting.attendees_updated",
      entity: "teams_meeting",
      entityId: eventId,
      metadata: { attendeeCount: String(input.attendees.length) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ meeting: result.meeting });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Delete a Teams meeting from the linked tenant (COSMOS-48) — removes it from the
 * organizer's calendar. The organizer mailbox is passed as an `?organizer=` query
 * param (a DELETE has no body). Gated on MEETING_DELETE.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, eventId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_DELETE);

    const organizer = request.nextUrl.searchParams.get("organizer")?.trim();
    if (!organizer) {
      return success({ error: "An organizer query param (M365 user id or UPN) is required." }, 400);
    }

    const result = await deleteTeamsMeeting(orgId, { organizer, eventId });
    if (!result.ok) return success({ error: result.error }, graphErrorStatus(result.error));

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "teams_meeting.deleted",
      entity: "teams_meeting",
      entityId: eventId,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
