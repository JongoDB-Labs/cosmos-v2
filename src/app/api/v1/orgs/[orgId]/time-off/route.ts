import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { readableTimeUserIds, timeUserIdFilter } from "@/lib/time/scope";
import { success, handleApiError } from "@/lib/api-helpers";
import { totalHours } from "@/lib/time/time-off";
import type { Prisma } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string }> };

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const STATUSES = ["PENDING", "APPROVED", "DENIED", "WITHDRAWN"] as const;
type Status = (typeof STATUSES)[number];
const asStatus = (v: string | null): Status | null =>
  v && (STATUSES as readonly string[]).includes(v) ? (v as Status) : null;

const createSchema = z
  .object({
    kind: z.enum(["VACATION", "SICK", "HOLIDAY", "UNPAID", "PARENTAL", "BEREAVEMENT", "OTHER"]),
    startDate: DATE,
    endDate: DATE,
    hoursPerDay: z.number().gt(0).max(24).optional(),
    note: z.string().max(2000).optional(),
    /** Filing on behalf of somebody else — a firm holiday, typically. */
    userId: z.string().uuid().optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "The last day cannot fall before the first",
    path: ["endDate"],
  });

const iso = (d: Date) => d.toISOString().slice(0, 10);

const shape = (r: {
  id: string;
  userId: string;
  kind: string;
  status: string;
  startDate: Date;
  endDate: Date;
  hoursPerDay: Prisma.Decimal;
  note: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}) => {
  const startDate = iso(r.startDate);
  const endDate = iso(r.endDate);
  const hoursPerDay = Number(r.hoursPerDay);
  return {
    id: r.id,
    userId: r.userId,
    kind: r.kind,
    status: r.status,
    startDate,
    endDate,
    hoursPerDay,
    // Derived, never stored: see lib/time/time-off.
    hours: totalHours({ startDate, endDate, hoursPerDay }),
    note: r.note,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt.toISOString(),
  };
};

const SELECT = {
  id: true,
  userId: true,
  kind: true,
  status: true,
  startDate: true,
  endDate: true,
  hoursPerDay: true,
  note: true,
  decidedById: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
} as const;

/**
 * Time off, read either as your own or as your team's.
 *
 * `?scope=team` is what an approver opens: everybody whose time this actor may
 * already read, which `readableTimeUserIds` defines once for the whole time
 * domain — self plus direct reports, or everyone for a TIME_READ_ALL holder.
 * Asking after one named person who is not in that set is REFUSED rather than
 * answered empty, so an empty list always means "nothing booked" and never
 * "you were not allowed to ask".
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);

    const sp = req.nextUrl.searchParams;
    const team = sp.get("scope") === "team";
    const asked = sp.get("userId");
    const status = asStatus(sp.get("status"));
    const from = sp.get("from");
    const to = sp.get("to");

    const allowed = await readableTimeUserIds(ctx); // null = may read everybody

    let who: Prisma.TimeOffRequestWhereInput;
    if (team) {
      // The shared filter shape, so the team view and the time-entry list
      // cannot drift apart on what "everybody I may read" means.
      const scoped = timeUserIdFilter(allowed);
      who = scoped ? { userId: scoped } : {};
    } else {
      const subject = asked || ctx.userId;
      if (subject !== ctx.userId && allowed !== null && !allowed.includes(subject)) {
        return new Response("Forbidden", { status: 403 });
      }
      who = { userId: subject };
    }

    const rows = await prisma.timeOffRequest.findMany({
      where: {
        orgId,
        ...who,
        ...(status ? { status } : {}),
        // Overlap, not containment: a fortnight off is in every week it touches.
        ...(to ? { startDate: { lte: new Date(`${to}T00:00:00.000Z`) } } : {}),
        ...(from ? { endDate: { gte: new Date(`${from}T00:00:00.000Z`) } } : {}),
      },
      select: SELECT,
      orderBy: [{ startDate: "desc" }],
    });
    return success(rows.map(shape));
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * Ask for time off — or, for somebody who may approve it, record a closure the
 * whole practice is subject to.
 *
 * A HOLIDAY filed by an approver lands APPROVED, because nobody asked for it:
 * routing the office Christmas closure to an approval queue would mean asking a
 * person to consent to a decision that has already been made. Every other kind
 * starts PENDING, including a holiday somebody files for themselves.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_CREATE);

    const body = createSchema.parse(await req.json());
    const mayDecide = hasPermission(ctx.permissions, Permission.TIME_APPROVE);

    const subject = body.userId ?? ctx.userId;
    if (subject !== ctx.userId && !mayDecide) {
      return new Response("Forbidden", { status: 403 });
    }

    const preApproved = body.kind === "HOLIDAY" && mayDecide;

    const created = await prisma.timeOffRequest.create({
      data: {
        orgId,
        userId: subject,
        kind: body.kind,
        startDate: new Date(`${body.startDate}T00:00:00.000Z`),
        endDate: new Date(`${body.endDate}T00:00:00.000Z`),
        hoursPerDay: body.hoursPerDay ?? 8,
        note: body.note ?? null,
        status: preApproved ? "APPROVED" : "PENDING",
        ...(preApproved
          ? { decidedById: ctx.userId, decidedAt: new Date() }
          : {}),
      },
      select: SELECT,
    });
    return success(shape(created), 201);
  } catch (e) {
    return handleApiError(e);
  }
}
