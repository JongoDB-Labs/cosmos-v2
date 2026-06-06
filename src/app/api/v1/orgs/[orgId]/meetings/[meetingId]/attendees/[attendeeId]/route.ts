import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updateAttendeeSchema = z.object({
  doneSinceLast: z.string().nullish(),
  workingOn: z.string().nullish(),
  blockers: z.string().nullish(),
  notes: z.string().nullish(),
});

type RouteParams = {
  params: Promise<{ orgId: string; meetingId: string; attendeeId: string }>;
};

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId, attendeeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_UPDATE);

    const meeting = await prisma.syncMeeting.findFirst({
      where: { id: meetingId, orgId },
    });
    if (!meeting) return new Response("Not found", { status: 404 });

    const existing = await prisma.meetingAttendee.findFirst({
      where: { id: attendeeId, meetingId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateAttendeeSchema.parse(body);

    const updated = await prisma.meetingAttendee.update({
      where: { id: attendeeId },
      data: {
        ...(data.doneSinceLast !== undefined && { doneSinceLast: data.doneSinceLast ?? "" }),
        ...(data.workingOn !== undefined && { workingOn: data.workingOn ?? "" }),
        ...(data.blockers !== undefined && { blockers: data.blockers ?? "" }),
        ...(data.notes !== undefined && { notes: data.notes ?? "" }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "meeting_attendee.updated",
      entity: "meeting_attendee",
      entityId: attendeeId,
      metadata: { meetingId, changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId, attendeeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_UPDATE);

    const meeting = await prisma.syncMeeting.findFirst({
      where: { id: meetingId, orgId },
    });
    if (!meeting) return new Response("Not found", { status: 404 });

    const existing = await prisma.meetingAttendee.findFirst({
      where: { id: attendeeId, meetingId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.meetingAttendee.delete({ where: { id: attendeeId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "meeting_attendee.removed",
      entity: "meeting_attendee",
      entityId: attendeeId,
      metadata: { meetingId, userId: existing.userId } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
