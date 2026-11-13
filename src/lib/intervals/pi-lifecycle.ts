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

/**
 * Nesting is one level deep: a Program Increment holds sprints (and the other
 * iteration kinds), and a PI is always top-level.
 *
 * Every reader assumes that. The board's interval tree lists a PI found inside
 * another PI as a PI of its own, and a PI's scope covers its direct children
 * only, so a PI inside a PI would be counted one way by one screen and another
 * way by the next. Each writer that sets `parentId` asks this first, and the
 * refusal says which rule it broke.
 */
export const PI_INSIDE_PI =
  "A Program Increment can't go inside another Program Increment. Only sprints and other iterations can be nested in one.";
export const PI_IS_TOP_LEVEL =
  "A Program Increment can't go inside another interval. It is always top-level.";
export const PARENT_NOT_FOUND = "Program Increment not found in this project";
export const PARENT_NOT_A_PI = "A sprint can only be nested under a Program Increment";

/**
 * Why an interval of `childKind` can't sit inside `parent`, or null when it can.
 * `parent` is what the requested parent id resolved to in this project, or null
 * when it resolved to nothing.
 */
export function nestingRefusal(
  childKind: string,
  parent: { intervalKind: string } | null,
): string | null {
  if (isProgramIncrement(childKind)) {
    return parent && isProgramIncrement(parent.intervalKind) ? PI_INSIDE_PI : PI_IS_TOP_LEVEL;
  }
  if (!parent) return PARENT_NOT_FOUND;
  if (!isProgramIncrement(parent.intervalKind)) return PARENT_NOT_A_PI;
  return null;
}

/**
 * Why an interval can't change kind to `nextKind`, or null when it can.
 *
 * Changing kind is a second way to break the nesting rule above: a sprint inside
 * a PI that becomes a PI is a PI inside a PI, and a PI that becomes a sprint
 * leaves its sprints inside something that is not a PI. Only the spreadsheet
 * import changes an existing interval's kind today.
 */
export function kindChangeRefusal(
  current: { intervalKind: string; parentId: string | null },
  nextKind: string,
  childCount: number,
): string | null {
  if (nextKind === current.intervalKind) return null;
  if (isProgramIncrement(nextKind) && current.parentId) {
    return "This interval is inside a Program Increment, so it can't become one. Take it out of its Program Increment first.";
  }
  if (isProgramIncrement(current.intervalKind) && childCount > 0) {
    return "This Program Increment still has intervals inside it, so it can't change kind. Move them out first.";
  }
  return null;
}
