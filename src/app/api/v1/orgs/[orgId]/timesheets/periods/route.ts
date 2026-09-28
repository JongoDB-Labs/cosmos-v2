import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { readableTimeUserIds } from "@/lib/time/scope";
import { NOT_VOIDED } from "@/lib/time/not-voided";
import { periodFor, type Period } from "@/lib/time/period";
import { DEFAULT_PERIOD_LENGTH } from "@/lib/time/timesheet";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

const dayAfter = (dateOnly: string) =>
  new Date(Date.parse(`${dateOnly}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Every pay period in a year, with whatever timesheet and hours it holds.
 *
 * Periods, not timesheets. A week nobody opened a sheet for still gets a row,
 * because the question this answers is "where are my gaps" and a list of only
 * the sheets that exist cannot show an absence. Monograph's own screen works
 * this way and it is the reason it is useful.
 *
 * Hours come from the ENTRIES, not the sheet, so a week reads its true total
 * before anyone submits it — which is exactly when somebody wants to look.
 *
 * The first row may start in the previous December: a period is claimed by the
 * year its Monday falls in nowhere else in this codebase, and slicing it any
 * other way here would disagree with the cheque.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);

    const sp = request.nextUrl.searchParams;
    const year = Number(sp.get("year"));
    if (!Number.isInteger(year) || year < 1970 || year > 2200) {
      return Response.json({ error: "year is required, e.g. 2026" }, { status: 400 });
    }

    // Somebody else's year only if their hours are readable at all — the SAME
    // rule the entries themselves use, so this can never become a side door.
    const subject = sp.get("userId") || ctx.userId;
    if (subject !== ctx.userId) {
      // null means "no filter" — the caller may read everybody's hours. Any
      // other value is the exact set, and a subject outside it is refused
      // rather than quietly returned empty, which would read as "they worked
      // nothing" instead of "that is not yours to see".
      const allowed = await readableTimeUserIds(ctx);
      if (allowed !== null && !allowed.includes(subject)) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    const periods: Period[] = [];
    let cursor = periodFor(`${year}-01-01`, DEFAULT_PERIOD_LENGTH);
    while (cursor.start <= `${year}-12-31`) {
      periods.push(cursor);
      cursor = periodFor(dayAfter(cursor.end), DEFAULT_PERIOD_LENGTH);
    }
    const first = periods[0].start;
    const last = periods[periods.length - 1].end;

    const [sheets, entries] = await Promise.all([
      prisma.timesheet.findMany({
        where: {
          orgId,
          userId: subject,
          periodStart: { gte: new Date(`${first}T00:00:00.000Z`) },
          periodEnd: { lte: new Date(`${last}T00:00:00.000Z`) },
        },
        select: { periodStart: true, status: true, submittedAt: true, updatedAt: true },
      }),
      prisma.timeEntry.findMany({
        where: {
          orgId,
          userId: subject,
          date: {
            gte: new Date(`${first}T00:00:00.000Z`),
            lte: new Date(`${last}T00:00:00.000Z`),
          },
          ...NOT_VOIDED,
        },
        select: { date: true, hours: true },
      }),
    ]);

    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const sheetByStart = new Map(sheets.map((s) => [iso(s.periodStart), s]));
    const hoursByStart = new Map<string, number>();
    for (const e of entries) {
      const key = periodFor(iso(e.date), DEFAULT_PERIOD_LENGTH).start;
      hoursByStart.set(key, (hoursByStart.get(key) ?? 0) + e.hours);
    }

    return success(
      periods.map((p) => {
        const sheet = sheetByStart.get(p.start);
        return {
          start: p.start,
          end: p.end,
          // OPEN, not null: a period with no sheet is one nobody has submitted,
          // which is a state rather than an absence of one.
          status: sheet?.status ?? "OPEN",
          hours: Math.round((hoursByStart.get(p.start) ?? 0) * 100) / 100,
          submittedAt: sheet?.submittedAt?.toISOString() ?? null,
          lastEditedAt: sheet?.updatedAt?.toISOString() ?? null,
        };
      }),
    );
  } catch (error) {
    return handleApiError(error);
  }
}
