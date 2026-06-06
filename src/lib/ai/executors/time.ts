import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { BillableType, type Prisma } from "@prisma/client";
import { z } from "zod";
import { assertPermission, type ToolContext } from "./_ctx";

const logTimeSchema = z.object({
  date: z.string().min(1),
  hours: z.number().positive(),
  projectId: z.string().uuid().nullable().optional(),
  workItemId: z.string().uuid().nullable().optional(),
  description: z.string().optional(),
  billableType: z.nativeEnum(BillableType).optional(),
  rate: z.number().nonnegative().optional(),
  client: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const listTimeEntriesSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  projectId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  billableType: z.nativeEnum(BillableType).optional(),
  limit: z.number().int().positive().optional(),
});

export async function logTime(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.TIME_CREATE);
  if (denied) return denied;

  const parsed = logTimeSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const entry = await prisma.timeEntry.create({
    data: {
      orgId: ctx.orgId,
      userId: ctx.userId,
      date: new Date(data.date),
      hours: data.hours,
      rate: data.rate ?? null,
      client: data.client ?? null,
      projectId: data.projectId ?? null,
      workItemId: data.workItemId ?? null,
      description: data.description ?? "",
      billableType: data.billableType ?? BillableType.BILLABLE,
      tags: data.tags ?? [],
    },
  });

  return {
    created: true,
    id: entry.id,
    date: entry.date,
    hours: entry.hours,
    billableType: entry.billableType,
  };
}

export async function listTimeEntries(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.TIME_READ);
  if (denied) return denied;

  const parsed = listTimeEntriesSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const where: Prisma.TimeEntryWhereInput = { orgId: ctx.orgId };
  if (data.userId) where.userId = data.userId;
  if (data.projectId) where.projectId = data.projectId;
  if (data.billableType) where.billableType = data.billableType;
  if (data.startDate || data.endDate) {
    where.date = {
      ...(data.startDate ? { gte: new Date(data.startDate) } : {}),
      ...(data.endDate ? { lte: new Date(data.endDate) } : {}),
    };
  }

  const limit = Math.min(data.limit ?? 100, 200);

  const entries = await prisma.timeEntry.findMany({
    where,
    orderBy: { date: "desc" },
    take: limit,
    select: {
      id: true,
      date: true,
      hours: true,
      rate: true,
      client: true,
      projectId: true,
      workItemId: true,
      userId: true,
      billableType: true,
      status: true,
      description: true,
    },
  });

  const totalHours = entries.reduce((sum, e) => sum + e.hours, 0);
  return { count: entries.length, totalHours, entries };
}
