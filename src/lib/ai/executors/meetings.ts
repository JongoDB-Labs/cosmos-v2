import { prisma } from "@/lib/db/client";
import { MeetingType, MeetingStatus, type Prisma } from "@prisma/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { assertPermission, type ToolContext } from "./_ctx";

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

  const where: Prisma.SyncMeetingWhereInput = { orgId: ctx.orgId };
  if (projectId) where.projectId = projectId;
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
  title: z.string().min(1),
  meetingDate: z.string().datetime(),
  projectId: z.string().uuid().nullish(),
  sprintId: z.string().uuid().nullish(),
  meetingType: z.nativeEnum(MeetingType).optional(),
  notes: z.string().nullish(),
});

export async function createMeeting(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.MEETING_CREATE);
  if (denied) return denied;

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  // A supplied project must be in this org (defense-in-depth; projectId is optional).
  if (data.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: data.projectId, orgId: ctx.orgId },
      select: { id: true },
    });
    if (!project) return { error: "Project not found" };
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
  notes: z.string().nullish(),
});

export async function updateMeeting(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.MEETING_UPDATE);
  if (denied) return denied;

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.syncMeeting.findFirst({
    where: { id: data.meetingId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!existing) return { error: "Meeting not found" };

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
    select: { id: true },
  });
  if (!existing) return { error: "Meeting not found" };

  await prisma.syncMeeting.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id };
}
