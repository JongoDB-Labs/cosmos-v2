import { prisma } from "@/lib/db/client";
import { periodFor, type PeriodLength } from "./period";
import { dateOnlyKey } from "./date-only";

/**
 * The pay period an entry belongs to, created on demand.
 *
 * Timesheets are upserted lazily on the first entry in a period rather than
 * provisioned ahead of time: nobody knows which periods a person will book
 * against, and empty timesheets for every user × every week is a table that
 * grows without anyone asking for it.
 *
 * `PeriodLength` is a parameter rather than a constant because it becomes a
 * per-org (and per-contract) policy in a later slice. Defaulting to WEEKLY
 * matches the backfill, which used Postgres `date_trunc('week', ...)` — ISO,
 * Monday-based, cross-checked against `periodFor` across a year of dates.
 */
export const DEFAULT_PERIOD_LENGTH: PeriodLength = "WEEKLY";

export async function timesheetIdForEntry(
  orgId: string,
  userId: string,
  entryDate: string | Date,
  length: PeriodLength = DEFAULT_PERIOD_LENGTH,
): Promise<string> {
  const dateOnly =
    entryDate instanceof Date
      ? entryDate.toISOString().slice(0, 10)
      : dateOnlyKey(entryDate);
  const { start, end } = periodFor(dateOnly, length);

  const where = {
    orgId_userId_periodStart: {
      orgId,
      userId,
      periodStart: new Date(`${start}T00:00:00.000Z`),
    },
  };

  try {
    const sheet = await prisma.timesheet.upsert({
      where,
      create: {
        orgId,
        userId,
        periodStart: new Date(`${start}T00:00:00.000Z`),
        periodEnd: new Date(`${end}T00:00:00.000Z`),
      },
      update: {},
      select: { id: true },
    });
    return sheet.id;
  } catch {
    // Two entries created in the same period at the same moment race to INSERT
    // and one loses on the unique index. The loser wants the winner's row, not
    // an error — re-read rather than surfacing a conflict the user did not cause.
    const existing = await prisma.timesheet.findUnique({
      where,
      select: { id: true },
    });
    if (existing) return existing.id;
    throw new Error("Could not resolve a timesheet for this entry");
  }
}

/** Statuses in which a timesheet is settled and its entries must not move. */
const CLOSED_STATUSES = ["SUBMITTED", "LABOR_APPROVED", "APPROVED", "LOCKED"];

/**
 * May entries in this timesheet still be changed?
 *
 * Reparenting an entry across a period boundary (by editing its date) is a real
 * business event, so it is refused once EITHER side is settled — otherwise
 * hours could be moved out of an approved period after the fact, which is
 * precisely what an audit trail exists to prevent.
 */
export async function isTimesheetOpen(
  timesheetId: string | null | undefined,
): Promise<boolean> {
  if (!timesheetId) return true; // no period yet — nothing settled to protect
  const sheet = await prisma.timesheet.findUnique({
    where: { id: timesheetId },
    select: { status: true },
  });
  // A missing timesheet reads as open: the entry is orphaned, not frozen.
  if (!sheet) return true;
  return !CLOSED_STATUSES.includes(sheet.status);
}
