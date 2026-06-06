import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { MeetingType } from "@prisma/client";

const createMeetingSchema = z.object({
  title: z.string().min(1, "Title is required"),
  projectId: z.string().uuid().nullish(),
  sprintId: z.string().uuid().nullish(),
  meetingDate: z.string(),
  meetingType: z.nativeEnum(MeetingType).optional(),
  notes: z.string().nullish(),
  attendeeIds: z.array(z.string().uuid()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_READ);

    const sp = request.nextUrl.searchParams;
    const projectId = sp.get("projectId");
    const sprintId = sp.get("sprintId");
    const meetingType = sp.get("meetingType");
    const status = sp.get("status");

    const where: Record<string, unknown> = { orgId };
    if (projectId) where.projectId = projectId;
    if (sprintId) where.sprintId = sprintId;
    if (meetingType) where.meetingType = meetingType;
    if (status) where.status = status;

    const meetings = await prisma.syncMeeting.findMany({
      where,
      include: {
        attendees: true,
      },
      orderBy: { meetingDate: "desc" },
    });

    const result = meetings.map((m) => ({
      ...m,
      attendeeCount: m.attendees.length,
    }));

    return success(result);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_CREATE);

    const body = await request.json();
    const data = createMeetingSchema.parse(body);

    const meeting = await prisma.syncMeeting.create({
      data: {
        orgId,
        title: data.title,
        projectId: data.projectId ?? null,
        sprintId: data.sprintId ?? null,
        meetingDate: new Date(data.meetingDate),
        meetingType: data.meetingType ?? "STANDUP",
        notes: data.notes ?? "",
        createdById: ctx.userId,
        ...(data.attendeeIds && data.attendeeIds.length > 0
          ? {
              attendees: {
                create: data.attendeeIds.map((userId) => ({ userId })),
              },
            }
          : {}),
      },
      include: {
        attendees: true,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "meeting.created",
      entity: "sync_meeting",
      entityId: meeting.id,
      metadata: {
        meetingType: meeting.meetingType,
        attendeeCount: String(meeting.attendees.length),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(meeting);
  } catch (error) {
    return handleApiError(error);
  }
}
