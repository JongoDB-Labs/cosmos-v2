import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission, ForbiddenError } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { redactRates } from "@/lib/time/visibility";
import { readableTimeUserIds, timeUserIdFilter } from "@/lib/time/scope";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { BillableType } from "@prisma/client";

const createTimeEntrySchema = z.object({
  date: z.string(),
  hours: z.number().positive(),
  rate: z.number().optional(),
  client: z.string().nullish(),
  projectId: z.string().uuid().nullish(),
  workItemId: z.string().uuid().nullish(),
  clinId: z.string().uuid().nullish(),
  description: z.string().nullish(),
  billableType: z.nativeEnum(BillableType).optional(),
  tags: z.array(z.string()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);

    const sp = request.nextUrl.searchParams;
    // `?userId=` with no value yields "", not null — and "" is NOT nullish, so
    // it survives the `??` below and would pin the query to userId="", matching
    // nothing and returning a silent empty list. Normalise to null so an empty
    // param means "unset", the way the other filters here already behave via
    // their `if (x)` guards.
    const userId = sp.get("userId") || null;
    const projectId = sp.get("projectId");
    const status = sp.get("status");
    const startDate = sp.get("startDate");
    const endDate = sp.get("endDate");
    const billableType = sp.get("billableType");

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

    return success({ data: redactRates(ctx, entries), total });
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
    requirePermission(ctx, Permission.TIME_CREATE);

    const body = await request.json();
    const data = createTimeEntrySchema.parse(body);

    const entry = await prisma.timeEntry.create({
      data: {
        orgId,
        userId: ctx.userId,
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

    return created(entry);
  } catch (error) {
    return handleApiError(error);
  }
}
