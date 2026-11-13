import { prisma } from "@/lib/db/client";
import { MeetingType, MeetingStatus, type Prisma } from "@prisma/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { assertPermission, assertProjectRead, loadAuthContext, type ToolContext } from "./_ctx";
import { canReadMeeting, readableMeetingsWhere } from "@/lib/meetings/meeting-reader";
import { SYNCED_MEETING_FIELDS, syncMeetingSoon } from "@/lib/integrations/microsoft/calendar-sync.server";

/**
 * Meeting executors — the org's sync meetings (SyncMeeting model — there is no
 * `Meeting` model). Every query is org-scoped. Mirrors
 * `api/v1/orgs/[orgId]/meetings/…`.
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

const MEETING_SELECT = {
  id: true, projectId: true, sprintId: true, customTypeId: true, meetingType: true,
  status: true, meetingDate: true, createdById: true, title: true, createdAt: true, updatedAt: true,
  // The Teams join link: the list is scoped like the REST list, so it reaches
  // only people who can see the meeting. Not structural, so a withheld result
  // drops it (egress projection), as it does the title.
  teamsJoinUrl: true,
} as const;

// ── list_meetings ─────────────────────────────────────────────────────────
const listSchema = z.object({
  projectId: z.string().uuid().optional(),
  sprintId: z.string().uuid().optional(),
  meetingType: z.nativeEnum(MeetingType).optional(),
  status: z.nativeEnum(MeetingStatus).optional(),
  limit: z.number().int().positive().optional(),
});

export async function listMeetings(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.MEETING_READ);
  if (denied) return denied;

  const parsed = listSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, sprintId, meetingType, status, limit } = parsed.data;

  // The same rule as the REST list and a meeting by id (meeting-reader.ts):
  // the project visible and MEETING_READ passing for it, policies included;
  // a meeting under no project, MEETING_READ alone.
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  let where: Prisma.SyncMeetingWhereInput;
  if (projectId) {
    if (!(await canReadMeeting(auth, projectId))) return { error: "Project not found" };
    where = { orgId: ctx.orgId, projectId };
  } else {
    where = await readableMeetingsWhere(auth);
  }
  if (sprintId) where.sprintId = sprintId;
  if (meetingType) where.meetingType = meetingType;
  if (status) where.status = status;

  const meetings = await prisma.syncMeeting.findMany({
    where,
    orderBy: { meetingDate: "desc" },
    take: Math.min(limit ?? 50, 100),
    select: MEETING_SELECT,
  });
  return { count: meetings.length, meetings };
}

// ── create_meeting ─────────────────────────────────────────────────────────
const createSchema = z.object({
  title: z.string().min(1).max(200),
  meetingDate: z.string().datetime(),
  projectId: z.string().uuid().nullish(),
  sprintId: z.string().uuid().nullish(),
  meetingType: z.nativeEnum(MeetingType).optional(),
  notes: z.string().max(10000).nullish(),
});

export async function createMeeting(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.MEETING_CREATE);
  if (denied) return denied;

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  // A supplied project must be in this org (defense-in-depth; projectId is optional).
  if (data.projectId) {
    const outOfScope = await assertProjectRead(ctx, data.projectId, "MEETING_CREATE");
    if (outOfScope) return outOfScope;
  }
  // SyncMeeting.sprintId has no FK relation (bare id) — require it to be one of
  // this org's intervals so an untrusted id can't plant a cross-org pointer.
  if (data.sprintId) {
    const sprint = await prisma.interval.findFirst({
      where: { id: data.sprintId, orgId: ctx.orgId },
      select: { id: true },
    });
    if (!sprint) return { error: "sprintId is not an interval in this organization" };
  }

  const created = await prisma.syncMeeting.create({
    data: {
      orgId: ctx.orgId,
      title: data.title,
      meetingDate: new Date(data.meetingDate),
      projectId: data.projectId ?? null,
      sprintId: data.sprintId ?? null,
      meetingType: data.meetingType ?? MeetingType.STANDUP,
      notes: data.notes ?? "",
      createdById: ctx.userId,
    },
    select: MEETING_SELECT,
  });
  return { created: true, id: created.id, meeting: created };
}

// ── update_meeting ─────────────────────────────────────────────────────────
const updateSchema = z.object({
  meetingId: z.string().uuid(),
  title: z.string().min(1).optional(),
  meetingDate: z.string().datetime().optional(),
  status: z.nativeEnum(MeetingStatus).optional(),
  notes: z.string().max(10000).nullish(),
});

export async function updateMeeting(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.MEETING_UPDATE);
  if (denied) return denied;

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.syncMeeting.findFirst({
    where: { id: data.meetingId, orgId: ctx.orgId },
    select: { id: true, projectId: true },
  });
  // A meeting the caller can't read answers as a missing one (the one
  // meeting-read rule, as REST's by-id doors). Then the write's own gate, for
  // a meeting under a project. Same message either way, so a refusal never
  // confirms the row is real.
  const auth = await loadAuthContext(ctx);
  if (!existing || !auth || !(await canReadMeeting(auth, existing.projectId))) return { error: "Meeting not found" };
  if (existing.projectId) {
    const outOfScope = await assertProjectRead(ctx, existing.projectId, "MEETING_UPDATE");
    if (outOfScope) return { error: "Meeting not found" };
  }

  const updated = await prisma.syncMeeting.update({
    where: { id: existing.id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.meetingDate !== undefined && { meetingDate: new Date(data.meetingDate) }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.notes !== undefined && { notes: data.notes ?? "" }),
    },
    select: MEETING_SELECT,
  });
  // Outlook copies follow, as a REST edit's do: a title that makes the meeting
  // classified ends its Teams meeting there, and nothing keeps a dead link.
  if (SYNCED_MEETING_FIELDS.some((f) => f in data)) syncMeetingSoon(ctx.orgId, updated.id);
  return { updated: true, id: updated.id, meeting: updated };
}

// ── delete_meeting ─────────────────────────────────────────────────────────
const deleteSchema = z.object({ meetingId: z.string().uuid() });

export async function deleteMeeting(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.MEETING_DELETE);
  if (denied) return denied;

  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);

  const existing = await prisma.syncMeeting.findFirst({
    where: { id: parsed.data.meetingId, orgId: ctx.orgId },
    select: { id: true, projectId: true },
  });
  // A meeting the caller can't read answers as a missing one (the one
  // meeting-read rule, as REST's by-id doors). Then the write's own gate, for
  // a meeting under a project. Same message either way, so a refusal never
  // confirms the row is real.
  const auth = await loadAuthContext(ctx);
  if (!existing || !auth || !(await canReadMeeting(auth, existing.projectId))) return { error: "Meeting not found" };
  if (existing.projectId) {
    const outOfScope = await assertProjectRead(ctx, existing.projectId, "MEETING_DELETE");
    if (outOfScope) return { error: "Meeting not found" };
  }

  await prisma.syncMeeting.delete({ where: { id: existing.id } });
  // The links outlive the meeting, so this removes everyone's Outlook copy (and its Teams meeting).
  syncMeetingSoon(ctx.orgId, existing.id);
  return { deleted: true, id: existing.id };
}
