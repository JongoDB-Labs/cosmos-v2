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

/**
 * Is this milestone's due date derived right now — i.e. NOT the user's to type?
 *
 * The edit dialog sends `dueDate` on every submit, including a plain rename, and
 * the API stores it. When the date is derived that stored value is discarded on
 * the next read, so the edit appears to work and then reverts. The UI uses this
 * to say so plainly instead: while the date follows linked work the field is
 * read-only, and turning Auto status off hands it back.
 *
 * Callers here know only the link COUNT, not whether the linked items carry
 * dates. That is deliberately coarser than `deriveMilestoneDueDate`, which keeps
 * the stored date when no linked item has one — so a milestone whose links are
 * all undated is shown as read-only while its stored date would in fact have
 * stuck. The cost of that corner is one toggle; the cost of the opposite error
 * is an edit that silently disappears, which is the bug being fixed.
 */
export function dueDateFollowsLinkedWork(autoStatus: boolean, linkCount: number): boolean {
  return autoStatus && linkCount > 0;
}
