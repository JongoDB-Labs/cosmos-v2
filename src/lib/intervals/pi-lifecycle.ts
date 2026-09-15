import type { IntervalKind, SprintStatus } from "@prisma/client";

/**
 * Program Increments are containers, not iterations.
 *
 * A PI is stored as an `Interval` row like any sprint, which made it subject to
 * rules written for iterations. The one-active-interval rule asked "is any
 * other interval in this project ACTIVE?", so an active PI blocked every sprint
 * inside it: the sprint could not start until its parent finished, and the
 * parent finishes only when its sprints do. Deadlock by construction.
 *
 * The model here: a PI *spans* its children. It becomes ACTIVE when its first
 * sprint starts, it is never started by hand, and it may be completed only once
 * every sprint inside it is done.
 */

const PROGRAM_INCREMENT: IntervalKind = "PROGRAM_INCREMENT";

interface IntervalLike {
  id: string;
  name: string;
  intervalKind: IntervalKind;
  status: SprintStatus;
}

/**
 * Takes a plain string, not the Prisma enum: this is called on both sides of the
 * JSON boundary, and the client's `Interval.intervalKind` is a string by the
 * time it reaches a component. Same shape as `boardTypeLabel`.
 */
export function isProgramIncrement(kind: string): boolean {
  return kind === PROGRAM_INCREMENT;
}

/**
 * The interval that prevents activating `candidate`, or null when nothing does.
 *
 * Only ONE iteration runs at a time in a project. A PI is excluded from that
 * count entirely: it is active for as long as anything inside it is running, so
 * counting it as a competitor is what created the deadlock.
 */
export function activationBlocker(
  candidate: { id: string },
  others: IntervalLike[]
): { id: string; name: string } | null {
  const blocker = others.find(
    (i) =>
      i.id !== candidate.id &&
      i.status === "ACTIVE" &&
      !isProgramIncrement(i.intervalKind)
  );
  return blocker ? { id: blocker.id, name: blocker.name } : null;
}

/**
 * The children standing between a PI and completion.
 *
 * Returned rather than a boolean so the refusal can name them — "finish Sprint 3
 * and Sprint 4" is actionable where "cannot complete" is not.
 */
export function programIncrementBlockers(
  children: IntervalLike[]
): { id: string; name: string }[] {
  return children
    .filter((c) => c.status !== "COMPLETED")
    .map((c) => ({ id: c.id, name: c.name }));
}

/**
 * Whether a user may move an interval of this kind to this status directly.
 *
 * A PI's start is derived: offering the control invites a PI that reports itself
 * running with nothing inside it, and a PI whose dates disagree with its
 * sprints. Completion stays a human decision — gated on the children, but a
 * person still decides the increment is done.
 */
export function userMaySetStatus(
  kind: string,
  status: SprintStatus
): boolean {
  if (isProgramIncrement(kind) && status === "ACTIVE") return false;
  return true;
}
