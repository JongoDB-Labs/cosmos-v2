import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { MeetingStatus } from "@prisma/client";
import { detectVideoProvider } from "@/lib/meetings/video";

const updateMeetingSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.nativeEnum(MeetingStatus).optional(),
  // Reschedule: an ISO datetime moving the meeting to a new slot.
  meetingDate: z.string().datetime().optional(),
  notes: z.string().nullish(),
  transcript: z.string().nullable().optional(),
  aiSummary: z.string().nullable().optional(),
  aiTickets: z.record(z.string(), z.unknown()).or(z.array(z.unknown())).optional(),
  meetingUrl: z.string().url().nullable().optional(),
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
      include: {
        attendees: true,
        customType: { select: { id: true, label: true } },
      },
    });

    if (!meeting) return new Response("Not found", { status: 404 });

    return success({ ...meeting, customTypeLabel: meeting.customType?.label ?? null });
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

    const existing = await prisma.syncMeeting.findFirst({
      where: { id: meetingId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: MEETING_UPDATE bitfield check + any narrowing deny
    // policy. SyncMeeting ownership is createdById; projectId may be null.
    // Identical to requirePermission until a policy exists.
    await requireAccess(ctx, "MEETING_UPDATE", {
      createdById: existing.createdById,
      projectId: existing.projectId,
    });

    const body = await request.json();
    const data = updateMeetingSchema.parse(body);

    const updated = await prisma.syncMeeting.update({
      where: { id: meetingId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.meetingDate !== undefined && {
          meetingDate: new Date(data.meetingDate),
        }),
        ...(data.notes !== undefined && { notes: data.notes ?? "" }),
        ...(data.transcript !== undefined && { transcript: data.transcript }),
        ...(data.aiSummary !== undefined && { aiSummary: data.aiSummary }),
        ...(data.aiTickets !== undefined && { aiTickets: data.aiTickets as Prisma.InputJsonValue }),
        ...(data.meetingUrl !== undefined && {
          meetingUrl: data.meetingUrl,
          videoProvider: data.meetingUrl ? detectVideoProvider(data.meetingUrl) : null,
        }),
      },
      include: { attendees: true },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "meeting.updated",
      entity: "sync_meeting",
      entityId: meetingId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, meetingId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.syncMeeting.findFirst({
      where: { id: meetingId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: MEETING_DELETE bitfield check + any narrowing deny
    // policy. SyncMeeting ownership is createdById; projectId may be null.
    // Identical to requirePermission until a policy exists.
    await requireAccess(ctx, "MEETING_DELETE", {
      createdById: existing.createdById,
      projectId: existing.projectId,
    });

    await prisma.syncMeeting.delete({ where: { id: meetingId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "meeting.deleted",
      entity: "sync_meeting",
      entityId: meetingId,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
