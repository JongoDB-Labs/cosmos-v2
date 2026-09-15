import { isProgramIncrement } from "./pi-lifecycle";

/**
 * Which intervals a sprint ceremony can be run on, and which one to open with.
 *
 * A ceremony reports on an ITERATION. A Program Increment is a container that
 * spans iterations (see pi-lifecycle), and it holds no work items of its own, so
 * a review of one reads 0 points and 0/0 items — a statement about the team that
 * the data does not support.
 *
 * The board previously took every interval the API returned and opened on
 * `.find(i => i.status === "ACTIVE")`. Two facts combine to make that pick the
 * PI almost every time:
 *
 *   - the API orders by `number` DESC, and a PI is numbered above its sprints;
 *   - a PI is ACTIVE for exactly as long as a sprint inside it is running.
 *
 * So in the normal state of a healthy project the PI sorted first AND matched
 * first, and the board opened on an empty increment.
 */

interface CeremonyIntervalLike {
  number: number;
  status: "PLANNED" | "ACTIVE" | "COMPLETED";
  intervalKind: string;
}

/**
 * Everything a ceremony may report on — an exclusion of PIs, not an allowlist of
 * SPRINT. `IntervalKind` has eight members and only one is a container; a
 * project running PHASEs or ITERATIONs must still get a picker with its work in
 * it.
 */
export function ceremonySelectableIntervals<T extends CeremonyIntervalLike>(
  intervals: T[],
): T[] {
  return intervals.filter((i) => !isProgramIncrement(i.intervalKind));
}

/**
 * The interval to open on: the one the team is in, else the one they just
 * finished (what a review is FOR), else the next one up.
 *
 * Null when the project has no iteration to report on — the caller must render
 * an empty state rather than fall back to a PI.
 */
export function defaultCeremonyInterval<T extends CeremonyIntervalLike>(
  intervals: T[],
): T | null {
  const selectable = ceremonySelectableIntervals(intervals);

  const active = selectable.find((i) => i.status === "ACTIVE");
  if (active) return active;

  const newestFirst = [...selectable].sort((a, b) => b.number - a.number);
  return (
    newestFirst.find((i) => i.status === "COMPLETED") ?? newestFirst[0] ?? null
  );
}
