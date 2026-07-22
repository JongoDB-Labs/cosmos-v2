/**
 * The ONE schedule-health rule for the unified item date model. Every surface
 * that colors a bar/pill or computes variance imports these — nothing re-derives
 * the comparison. Health = Actual End vs the CURRENT Projected End ("current plan
 * only", no frozen baseline); while open it falls back to today-vs-Projected.
 */
export type ScheduleHealth = "green" | "red" | "neutral";

export interface HealthInput {
  projectedEnd: Date | null;
  actualEnd: Date | null;
  now: Date;
}

export function healthOf({ projectedEnd, actualEnd, now }: HealthInput): ScheduleHealth {
  if (!projectedEnd) return "neutral";
  if (actualEnd) return actualEnd.getTime() <= projectedEnd.getTime() ? "green" : "red";
  return now.getTime() > projectedEnd.getTime() ? "red" : "green";
}

/** Whole-day variance: (actualEnd ?? now) − projectedEnd. Positive = late. */
export function slipDays({ projectedEnd, actualEnd, now }: HealthInput): number | null {
  if (!projectedEnd) return null;
  const ref = actualEnd ?? now;
  return Math.round((ref.getTime() - projectedEnd.getTime()) / 86_400_000);
}
