import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { hoursInWindow } from "./time-off";

/**
 * Time-off balances: for one person and one calendar year, how much leave was
 * asked for, how much is approved and still to come, how much has been taken,
 * and how much of their allowance is left.
 *
 * Everything is DERIVED from the requests, the same way weekly totals are
 * (see time-off.ts): storing a running balance would go stale the first time
 * somebody moved a date or an approver changed their mind.
 *
 * Only the kinds that draw on the allowance count (vacation, by default).
 * Sick leave, firm holidays and the rest are real absences but not spent from
 * a person's allowance, and counting them would understate what they have
 * left.
 *
 * Client-safe: no server imports.
 */

const TIME_OFF_KINDS = ["VACATION", "SICK", "HOLIDAY", "UNPAID", "PARENTAL", "BEREAVEMENT", "OTHER"] as const;
export type TimeOffKindName = (typeof TIME_OFF_KINDS)[number];

export interface TimeOffPolicy {
  /** Hours a year each person may take, unless they have their own figure. Null = no org-wide allowance. */
  annualAllowanceHours: number | null;
  /** The kinds that draw on the allowance. */
  countedKinds: TimeOffKindName[];
}

const DEFAULT_COUNTED: TimeOffKindName[] = ["VACATION"];

/** The org's policy, from Organization.settings.time.timeOff. */
export function timeOffPolicy(settings: unknown): TimeOffPolicy {
  const t = ((settings ?? {}) as { time?: { timeOff?: { annualAllowanceHours?: unknown; countedKinds?: unknown } } }).time
    ?.timeOff;
  const hours = t?.annualAllowanceHours;
  const kinds = t?.countedKinds;
  return {
    annualAllowanceHours: typeof hours === "number" && Number.isFinite(hours) && hours >= 0 ? hours : null,
    countedKinds:
      Array.isArray(kinds) && kinds.length > 0 && kinds.every((k) => (TIME_OFF_KINDS as readonly string[]).includes(k))
        ? (kinds as TimeOffKindName[])
        : DEFAULT_COUNTED,
  };
}

export interface BalanceRequest {
  kind: string;
  status: string;
  startDate: string;
  endDate: string;
  hoursPerDay: number;
}

export interface TimeOffBalance {
  /** Still waiting on a decision. Not taken off the remaining figure: nobody has agreed to it yet. */
  requested: number;
  /** Approved and still to come this year. */
  approved: number;
  /** Approved and already taken, up to and including today. */
  used: number;
  allowance: number | null;
  /** allowance − used − approved; null without an allowance. Negative when overdrawn. */
  remaining: number | null;
}

/**
 * One person's balance for `year`, as of `today` (YYYY-MM-DD).
 *
 * A request crossing New Year is split at it: each year owes only its own
 * days. A request crossing TODAY is split there too, so a week off that began
 * on Wednesday reads as part used and part still to come.
 */
export function timeOffBalance(
  requests: readonly BalanceRequest[],
  opts: { year: number; today: string; countedKinds: readonly string[]; allowance: number | null },
): TimeOffBalance {
  const yearStart = `${opts.year}-01-01`;
  const yearEnd = `${opts.year}-12-31`;
  const tomorrow = new Date(Date.parse(`${opts.today}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
  let requested = 0;
  let approved = 0;
  let used = 0;
  for (const r of requests) {
    if (!opts.countedKinds.includes(r.kind)) continue;
    if (r.status === "PENDING") {
      requested += hoursInWindow(r, yearStart, yearEnd);
    } else if (r.status === "APPROVED") {
      // hoursInWindow already gives 0 for an empty window (start after end).
      used += hoursInWindow(r, yearStart, opts.today < yearEnd ? opts.today : yearEnd);
      approved += hoursInWindow(r, tomorrow > yearStart ? tomorrow : yearStart, yearEnd);
    }
    // DENIED and WITHDRAWN never happened.
  }
  return {
    requested,
    approved,
    used,
    allowance: opts.allowance,
    remaining: opts.allowance === null ? null : opts.allowance - used - approved,
  };
}

/**
 * Setting allowances is an HR decision about everyone, so it needs org-wide
 * time access AND approval rights — a supervisor who can approve their own
 * reports' leave does not thereby set anybody's entitlement.
 */
export function canManageAllowances(permissions: bigint): boolean {
  return hasPermission(permissions, Permission.TIME_READ_ALL) && hasPermission(permissions, Permission.TIME_APPROVE);
}
