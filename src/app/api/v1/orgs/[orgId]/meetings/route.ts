import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { canReadMeeting, readableMeetingsWhere } from "@/lib/meetings/meeting-reader";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress, readJsonBody } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { pullSoonIfStale } from "@/lib/integrations/microsoft/calendar-sync.server";
import { createSyncMeeting, meetingRefusalResponse } from "@/lib/meetings/create-meeting.server";
import { z } from "zod";
import { MeetingType } from "@prisma/client";
import { requireProjectVisibleIf } from "@/lib/rbac/require-project-read";
import { assertRefsInScope } from "@/lib/rbac/foreign-refs";

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
  // COSMOS-202: how long the meeting runs, for calendars it is mirrored into.
  durationMinutes: z.number().int().min(5).max(24 * 60).optional(),
  // Make it a Teams meeting, held in the creator's own Outlook (connected).
  teamsMeeting: z.boolean().optional(),
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
    // COSMOS-202 B2: their Outlook edits, fetched after this response if stale.
    if (!ctx.isApiKey) pullSoonIfStale(orgId, ctx.userId);

    const sp = request.nextUrl.searchParams;
    const projectId = sp.get("projectId");
    const sprintId = sp.get("sprintId");
    const meetingType = sp.get("meetingType");
    const status = sp.get("status");

    // MEETING_READ is held by MEMBER and VIEWER, so it authorises reading SOME
    // meetings and says nothing about WHICH: the one meeting-read rule does
    // (meeting-reader.ts), as it does for a meeting by id and for Cosmo. A
    // meeting's project must be visible to the caller and MEETING_READ must
    // pass for it, policies included; a meeting under no project needs
    // MEETING_READ alone.
    let where: Record<string, unknown>;
    if (projectId) {
      // Naming a project whose meetings the caller can't read is a denial,
      // matching the contract of every other project-scoped route.
      if (!(await canReadMeeting(ctx, projectId))) {
        return new Response(JSON.stringify({ error: "Access denied by policy" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      where = { orgId, projectId };
    } else {
      where = { ...(await readableMeetingsWhere(ctx)) };
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

    const body = await readJsonBody(request);
    const data = createMeetingSchema.parse(body);
    // Filing it under a project is writing to that project.
    await requireProjectVisibleIf(ctx, data.projectId);
    // The sprint has no foreign key, so nothing else stops another org's id:
    // it must be the meeting's project's, or one the caller can see.
    await assertRefsInScope({ orgId, projectId: data.projectId, viewer: ctx }, { interval: data.sprintId });

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

    // Checked, saved and pushed to Outlook in one step, the path Cosmo's create
    // takes too: attendees must be in the org, and a Teams meeting (made in the
    // creator's own Outlook, never on an API key) is refused before anything is
    // saved, so nobody gets a meeting they didn't ask for.
    const made = await createSyncMeeting(
      {
        data: {
          orgId,
          title: data.title,
          projectId: data.projectId ?? null,
          sprintId: data.sprintId ?? null,
          meetingDate: new Date(data.meetingDate),
          ...(data.durationMinutes !== undefined && { durationMinutes: data.durationMinutes }),
          meetingType: data.customTypeId ? "OTHER" : data.meetingType ?? "STANDUP",
          customTypeId: data.customTypeId ?? null,
          notes: data.notes ?? "",
          createdById: ctx.userId,
        },
        attendeeIds: data.attendeeIds,
        teamsMeeting: data.teamsMeeting,
        isApiKey: !!ctx.isApiKey,
      },
      { include: { attendees: true } },
      {
        // Audited before the push is queued: if the audit fails, the 500 is
        // for a meeting no one's Outlook has, so a retry can't add a second copy.
        beforePush: (meeting) =>
          logAudit({
            orgId,
            userId: ctx.userId,
            action: "meeting.created",
            entity: "sync_meeting",
            entityId: meeting.id,
            metadata: {
              meetingType: meeting.meetingType,
              attendeeCount: String(meeting.attendees.length),
              ...(meeting.teamsHostId && { teamsMeeting: "on" }),
            } as Record<string, string>,
            ipAddress: getIpAddress(request),
          }),
      },
    );
    if (made.refused) return meetingRefusalResponse(made.refused);

    return created(made.meeting);
  } catch (error) {
    return handleApiError(error);
  }
}
