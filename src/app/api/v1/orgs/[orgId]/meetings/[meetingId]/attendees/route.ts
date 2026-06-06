import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notifications/create";
import { z } from "zod";

const addAttendeeSchema = z.object({
  userId: z.string().uuid(),
});

const bulkUpdateSchema = z.object({
  attendees: z.array(
    z.object({
      userId: z.string().uuid(),
      doneSinceLast: z.string().nullish(),
      workingOn: z.string().nullish(),
      blockers: z.string().nullish(),
      notes: z.string().nullish(),
    })
  ),
});

type RouteParams = { params: Promise<{ orgId: string; meetingId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_READ);

    const meeting = await prisma.syncMeeting.findFirst({
      where: { id: meetingId, orgId },
    });
    if (!meeting) return new Response("Not found", { status: 404 });

    const attendees = await prisma.meetingAttendee.findMany({
      where: { meetingId },
    });

    return success(attendees);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_UPDATE);

    const meeting = await prisma.syncMeeting.findFirst({
      where: { id: meetingId, orgId },
    });
    if (!meeting) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = addAttendeeSchema.parse(body);

    const attendee = await prisma.meetingAttendee.create({
      data: {
        meetingId,
        userId: data.userId,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "meeting_attendee.added",
      entity: "meeting_attendee",
      entityId: attendee.id,
      metadata: { meetingId, addedUserId: data.userId } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Notify the new attendee (unless they added themselves)
    if (attendee.userId !== ctx.userId) {
      const meetingLabel = meeting.meetingType
        ? meeting.meetingType.toString().toLowerCase()
        : "meeting";
      await createNotification({
        orgId,
        userId: attendee.userId,
        type: "meeting.invited",
        title: `Invited to ${meetingLabel}`,
        message: meeting.meetingDate
          ? `Scheduled ${new Date(meeting.meetingDate).toLocaleString()}`
          : "",
        relatedId: meetingId,
        relatedType: "meeting",
        url: `/${org.slug}/meetings/${meetingId}`,
      }).catch(() => {
        /* swallow */
      });
    }

    return created(attendee);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_UPDATE);

    const meeting = await prisma.syncMeeting.findFirst({
      where: { id: meetingId, orgId },
    });
    if (!meeting) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = bulkUpdateSchema.parse(body);

    const results = await Promise.all(
      data.attendees.map((a) =>
        prisma.meetingAttendee.upsert({
          where: {
            meetingId_userId: { meetingId, userId: a.userId },
          },
          create: {
            meetingId,
            userId: a.userId,
            doneSinceLast: a.doneSinceLast ?? "",
            workingOn: a.workingOn ?? "",
            blockers: a.blockers ?? "",
            notes: a.notes ?? "",
          },
          update: {
            ...(a.doneSinceLast !== undefined && { doneSinceLast: a.doneSinceLast ?? "" }),
            ...(a.workingOn !== undefined && { workingOn: a.workingOn ?? "" }),
            ...(a.blockers !== undefined && { blockers: a.blockers ?? "" }),
            ...(a.notes !== undefined && { notes: a.notes ?? "" }),
          },
        })
      )
    );

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "meeting_attendees.bulk_updated",
      entity: "meeting_attendee",
      entityId: meetingId,
      metadata: { count: String(data.attendees.length) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(results);
  } catch (error) {
    return handleApiError(error);
  }
}
