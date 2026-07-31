/**
 * The remaining ticket-metadata lenses for a board.
 *
 * Each is a pure predicate so the rule can be tested without a board, and so
 * the Kanban and the Timeline share one definition rather than drifting apart —
 * which is how "the same filter behaves differently over here" starts.
 *
 * DATES ARE PRESETS, NOT A PICKER. A filter bar is for quick lenses; dropping a
 * calendar into one breaks that rhythm and answers a question nobody asked
 * ("items due on exactly 14 March"). What people actually ask a board is "what
 * is late" and "what lands this week", so those are the options.
 */

export type DuePreset = "any" | "overdue" | "week" | "month" | "none";

export const DUE_PRESETS: { value: DuePreset; label: string }[] = [
  { value: "any", label: "Any due date" },
  { value: "overdue", label: "Overdue" },
  { value: "week", label: "Due this week" },
  { value: "month", label: "Due this month" },
  { value: "none", label: "No due date" },
];

/**
 * `now` is injected rather than read from the clock so "this week" is testable
 * and so every item in one pass is judged against the same instant — reading the
 * clock per item lets a filter change its mind mid-list at a midnight boundary.
 */
export function matchesDuePreset(
  dueDate: string | Date | null | undefined,
  preset: DuePreset,
  now: Date,
): boolean {
  if (preset === "any") return true;

  // Resolve to a usable date FIRST. An unparseable value is no more a date than
  // a missing one, and deciding "none" before parsing meant a corrupt date was
  // reported as having a due date it does not have.
  const due = dueDate ? (dueDate instanceof Date ? dueDate : new Date(dueDate)) : null;
  const usable = due && !Number.isNaN(due.getTime()) ? due : null;

  if (!usable) return preset === "none";
  if (preset === "none") return false;

  if (preset === "overdue") return usable.getTime() < now.getTime();

  // "Within the next 7 / 30 days", not "in the current calendar week". A board
  // is read as a rolling horizon — on a Friday, "this week" meaning two
  // remaining days would hide most of what the reader is looking for.
  const days = preset === "week" ? 7 : 30;
  const horizon = new Date(now.getTime());
  horizon.setDate(horizon.getDate() + days);
  return usable.getTime() >= now.getTime() && usable.getTime() <= horizon.getTime();
}

/** Multi-select over a single-valued field: empty selection is inert. */
export function matchesOneOf(
  value: string | null | undefined,
  selected: string[],
): boolean {
  if (selected.length === 0) return true;
  if (!value) return false;
  return selected.includes(value);
}
