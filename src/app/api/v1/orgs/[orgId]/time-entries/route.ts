import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requirePermission, ForbiddenError } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { requireProjectRead, requireProjectVisibleIf } from "@/lib/rbac/require-project-read";
import { redactRates } from "@/lib/time/visibility";
import { readableTimeUserIds, timeUserIdFilter } from "@/lib/time/scope";
import { timesheetIdForEntry } from "@/lib/time/timesheet";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { orgContext } from "@/lib/openapi/org-context";
import { createTimeEntry, listTimeEntries } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listTimeEntries);
    const { params: { orgId }, query } = await parseRequest(listTimeEntries, request, params);
    requirePermission(ctx, Permission.TIME_READ);

    // `?userId=` with no value yields "", not null — and "" is NOT nullish, so
    // it survives the `??` below and would pin the query to userId="", matching
    // nothing and returning a silent empty list. Normalise to null so an empty
    // param means "unset", the way the other filters here already behave via
    // their `if (x)` guards.
    const userId = query.userId || null;
    const { projectId, status, startDate, endDate, billableType } = query;

    // TIME_READ alone means "this org does timekeeping and you take part" —
    // MEMBER and VIEWER both hold it. Reading OTHER people's rows needs either
    // TIME_READ_ALL or a supervisory relationship: `allowed` is null for the
    // former and [self, ...direct reports] otherwise.
    const allowed = await readableTimeUserIds(ctx);
    // Naming someone outside that set is a denial rather than a silent
    // narrowing: a caller that asked for Bob's rows and got its own has been
    // given a wrong answer, not a safe one.
    if (allowed && userId && !allowed.includes(userId)) {
      throw new ForbiddenError("Access denied by policy");
    }

    const where: Record<string, unknown> = { orgId };
    // Voided entries are RETAINED but never shown. The record survives for the
    // audit trail; the product behaves as though the row is gone.
    where.voidedAt = null;
    // An explicit (and permitted) userId always wins; otherwise fall back to
    // the readable set, or `undefined` — "no filter" to Prisma — for READ_ALL.
    where.userId = userId ?? timeUserIdFilter(allowed);
    if (projectId) {
      // The same gate the routes under projects/[projectId] use (#505): the
      // action's own bit plus team scoping. Without it this org-level endpoint
      // is a side door to precisely the rows that gate closed the front door on.
      await requireProjectRead(ctx, projectId, "TIME_READ");
      where.projectId = projectId;
    }
    if (status) where.status = status;
    if (billableType) where.billableType = billableType;
    if (startDate || endDate) {
      where.date = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {}),
      };
    }

    const [entries, total] = await Promise.all([
      prisma.timeEntry.findMany({
        where,
        orderBy: { date: "desc" },
      }),
      prisma.timeEntry.count({ where }),
    ]);

    return respond(listTimeEntries, 200, { data: redactRates(ctx, entries), total });
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, createTimeEntry);
    const { params: { orgId }, body: data } = await parseRequest(createTimeEntry, request, params);
    // Logging time against a project is writing to that project.
    await requireProjectVisibleIf(ctx, data.projectId);
    requirePermission(ctx, Permission.TIME_CREATE);

    // Resolve the pay period BEFORE the insert so an entry is never briefly
    // unattached — a row with no timesheet is invisible to every period-level
    // read, and "briefly" is long enough for a concurrent report to miss it.
    const timesheetId = await timesheetIdForEntry(orgId, ctx.userId, data.date);

    const entry = await prisma.timeEntry.create({
      data: {
        orgId,
        userId: ctx.userId,
        timesheetId,
        date: new Date(data.date),
        hours: data.hours,
        rate: data.rate ?? null,
        client: data.client ?? null,
        projectId: data.projectId ?? null,
        workItemId: data.workItemId ?? null,
        clinId: data.clinId ?? null,
        description: data.description ?? "",
        billableType: data.billableType ?? "BILLABLE",
        tags: data.tags ?? [],
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "time_entry.created",
      entity: "time_entry",
      entityId: entry.id,
      metadata: { hours: String(data.hours), date: data.date } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return respond(createTimeEntry, 201, entry);
  } catch (error) {
    return handleApiError(error, request);
  }
}
