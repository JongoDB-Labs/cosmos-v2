/**
 * Collisions on the Gantt: a bar dropped on top of a sibling's dates.
 *
 * Dragging a bar could silently lay it over a sibling's, and for work that is
 * meant to run one after another (a project's phases, a parent's stages) that
 * is a scheduling decision, not a side effect. So a drop that NEWLY overlaps a
 * sibling is held back, and the person chooses: run them in parallel, push the
 * sibling later, push it earlier, or cancel.
 *
 * - **Sibling**: same parent. Items with no parent are not siblings of each
 *   other: a flat project's tasks overlap all the time, and asking about every
 *   one of them would make every drag a dialog.
 * - **Both scheduled**: each has a real start and due date. A bar drawn from
 *   the fallbacks (created date, start + 7 days) is not a plan to collide with.
 * - **Newly**: it did not overlap that sibling before the drop. Siblings that
 *   were already running in parallel were decided on earlier.
 * - **Overlap**: they share more than a boundary. One finishing on the day the
 *   next starts is a handover, not a collision.
 *
 * Pure: dates in, dates out. Dates are compared as the local calendar days the
 * chart draws, the same as the drag itself.
 */

export interface CollisionItem {
  id: string;
  parentId: string | null;
  startDate: string | null;
  dueDate: string | null;
}

export interface DayRange {
  start: Date;
  end: Date;
}

export interface Collision {
  id: string;
  /** The sibling's own dates, before anything is pushed. */
  start: Date;
  end: Date;
  /** Its dates if pushed later so it starts when the moved item ends. */
  later: DayRange;
  /** Its dates if pushed earlier so it ends when the moved item starts. */
  earlier: DayRange;
}

const DAY = 86_400_000;

function localDay(iso: string): Date {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function shift(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function days(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY);
}

/** They share more than a boundary day. */
export function overlaps(a: DayRange, b: DayRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function findCollisions(
  moved: { id: string; parentId: string | null; before: DayRange; after: DayRange },
  items: readonly CollisionItem[],
): Collision[] {
  if (moved.parentId === null) return [];
  const out: Collision[] = [];
  for (const it of items) {
    if (it.id === moved.id || it.parentId !== moved.parentId) continue;
    if (!it.startDate || !it.dueDate) continue;
    const span = { start: localDay(it.startDate), end: localDay(it.dueDate) };
    if (!overlaps(moved.after, span) || overlaps(moved.before, span)) continue;
    const toLater = days(span.start, moved.after.end);
    const toEarlier = days(span.end, moved.after.start);
    out.push({
      id: it.id,
      start: span.start,
      end: span.end,
      later: { start: shift(span.start, toLater), end: shift(span.end, toLater) },
      earlier: { start: shift(span.start, toEarlier), end: shift(span.end, toEarlier) },
    });
  }
  return out;
}
