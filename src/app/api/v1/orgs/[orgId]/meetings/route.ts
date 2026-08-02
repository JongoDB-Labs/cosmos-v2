import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
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
  // Org-defined custom type. When set, meetingType is forced to OTHER.
  customTypeId: z.string().uuid().nullish(),
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

    // MEETING_READ is held by MEMBER and VIEWER, so it authorises reading SOME
    // meetings and says nothing about WHICH. `SyncMeeting.projectId` is real
    // (and nullable), so without narrowing this listed every meeting in the org
    // — including those on projects with `teamScopedAccess` that the caller is
    // not a member of, whose records carry notes and transcripts.
    //
    // The agent was fixed first (2.265.3), which left the UI looser than the
    // assistant: a user could see a meeting on screen that Cosmo refused to
    // discuss. This closes that from the other end.
    const readable = await getReadableProjectIds(ctx);

    const where: Record<string, unknown> = { orgId };
    if (projectId) {
      // Naming a project outside the readable set is a denial, matching the
      // contract of every other project-scoped route.
      if (!readable.includes(projectId)) {
        return new Response(JSON.stringify({ error: "Access denied by policy" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      where.projectId = projectId;
    } else {
      // Meetings with NO project are org-level and stay visible to everyone who
      // may read meetings at all.
      where.OR = [{ projectId: null }, { projectId: { in: readable } }];
    }
    if (sprintId) where.sprintId = sprintId;
    if (meetingType) where.meetingType = meetingType;
    if (status) where.status = status;

    const meetings = await prisma.syncMeeting.findMany({
      where,
      include: {
        attendees: true,
        customType: { select: { id: true, label: true } },
      },
      orderBy: { meetingDate: "desc" },
    });

    const result = meetings.map((m) => ({
      ...m,
      attendeeCount: m.attendees.length,
      customTypeLabel: m.customType?.label ?? null,
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

    // Validate a custom type belongs to this org (defense-in-depth); when set,
    // the built-in enum is OTHER and the label comes from the custom type.
    if (data.customTypeId) {
      const owned = await prisma.meetingTypeOption.findFirst({
        where: { id: data.customTypeId, orgId },
        select: { id: true },
      });
      if (!owned) {
        return new Response(
          JSON.stringify({ error: "Unknown meeting type" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    const meeting = await prisma.syncMeeting.create({
      data: {
        orgId,
        title: data.title,
        projectId: data.projectId ?? null,
        sprintId: data.sprintId ?? null,
        meetingDate: new Date(data.meetingDate),
        meetingType: data.customTypeId ? "OTHER" : data.meetingType ?? "STANDUP",
        customTypeId: data.customTypeId ?? null,
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
