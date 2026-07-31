/**
 * A milestone's due date, derived from the work linked to it.
 *
 * `Milestone.autoStatus` has always meant "this milestone follows its linked
 * work" — deriveMilestone reads it to compute status. The DATE never followed,
 * so a milestone converted from a ticket (#489) kept whatever date it was
 * created with while the ticket's planned end moved underneath it, and the
 * board and the issue quietly disagreed. Reported from the running app.
 *
 * This extends the same flag to the thing it always implied. Nothing changes
 * for a milestone someone manages by hand (autoStatus false) or one with no
 * linked work.
 */

export interface LinkedItemDate {
  /** The linked work item's planned end, or null if it has none. */
  dueDate: Date | null;
}

export function deriveMilestoneDueDate(
  storedDueDate: Date,
  autoStatus: boolean,
  links: LinkedItemDate[],
): Date {
  if (!autoStatus) return storedDueDate;

  const dates = links
    .map((l) => l.dueDate)
    .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));

  // Milestone.dueDate is NOT NULL and there is nothing to fall back to, so an
  // absent date means keep what is stored. Inventing one would put a date on
  // the Release Timeline and the schedule-variance report as though someone had
  // committed to it — the same reasoning that made #489 skip undated items.
  if (dates.length === 0) return storedDueDate;

  // LATEST, not earliest: the milestone is not reached until all of its work is,
  // so the earliest date would mark it met while work remains outstanding.
  return dates.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
}
