import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { BillableType, type Prisma } from "@prisma/client";
import { z } from "zod";
import { assertPermission, loadAuthContext, type ToolContext } from "./_ctx";
import { NOT_VOIDED } from "@/lib/time/not-voided";
import { readableTimeUserIds, timeUserIdFilter } from "@/lib/time/scope";
import { redactRates } from "@/lib/time/visibility";

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

  // TIME_READ is held by MEMBER and VIEWER — by everyone — so it says the actor
  // may read SOME time, never WHOSE. The scope is a second question, and the
  // same helper answers it here as in GET /time-entries. Asking it separately
  // is what let this tool return the whole org's hours, rates included.
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  const allowed = await readableTimeUserIds(auth);

  const parsed = listTimeEntriesSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  // Voided entries must not reach the agent either — it answers questions
  // about hours, and a deleted entry is not an hour anyone worked.
  const where: Prisma.TimeEntryWhereInput = { orgId: ctx.orgId, ...NOT_VOIDED };
  // "Whose hours?" is a legitimate question — a supervisor asking about a
  // report. It is answered AGAINST the scope, never instead of it: naming
  // somebody outside it is a denial, matching the HTTP route's contract rather
  // than silently returning nothing, so the assistant can say why.
  if (data.userId) {
    if (allowed && !allowed.includes(data.userId)) {
      return { error: "Access denied by policy" };
    }
    where.userId = data.userId;
  } else {
    where.userId = timeUserIdFilter(allowed);
  }
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
  // Same choke point as the HTTP routes: rate is own-row-or-FINANCE_READ.
  // Confirming somebody's hours does not require seeing their pay, and an
  // assistant that will read the number aloud is the last place to relax that.
  return { count: entries.length, totalHours, entries: redactRates(auth, entries) };
}
