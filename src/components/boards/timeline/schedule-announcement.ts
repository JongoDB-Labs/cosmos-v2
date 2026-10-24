/**
 * What a screen reader hears after a Gantt reschedule, an undo or a redo.
 *
 * A drag ends in a generic "Schedule updated" toast, and undo/redo said nothing
 * at all, so someone who can't see the bars had no way to know which item moved,
 * where to, or that the dependents moved with it, let alone that it could be
 * taken back. These sentences name the item, its new dates and how many others
 * the cascade moved, and say how to undo.
 *
 * Pure: the component renders the result into a polite live region.
 */

export interface AnnouncedRange {
  startDate: string | null;
  dueDate: string | null;
}

export interface AnnouncedEdit {
  /** The item the user dragged first; the rest are what its cascade moved. */
  items: { id: string; before: AnnouncedRange; after: AnnouncedRange }[];
}

export type ScheduleAction = "moved" | "undo" | "redo";

// The viewer's own calendar day, the same day the bar is drawn on and the
// tooltip shows (timeline-view's startOfDay and toLocaleDateString are local).
// Day-month-year words read unambiguously aloud, unlike 3/4/2026.
const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

function range(r: AnnouncedRange): string {
  const s = r.startDate ? day.format(new Date(r.startDate)) : null;
  const e = r.dueDate ? day.format(new Date(r.dueDate)) : null;
  if (s && e) return s === e ? s : `${s} to ${e}`;
  if (e) return `due ${e}`;
  if (s) return `starting ${s}`;
  return "no dates";
}

function others(n: number, verb: string): string {
  if (n === 0) return "";
  return n === 1 ? ` 1 dependent item ${verb}.` : ` ${n} dependent items ${verb}.`;
}

export function announceSchedule(
  action: ScheduleAction,
  edit: AnnouncedEdit,
  labelFor: (id: string) => string,
): string {
  const [first, ...rest] = edit.items;
  if (!first) return "";
  const label = labelFor(first.id);
  switch (action) {
    case "moved":
      return `Moved ${label} to ${range(first.after)}.${others(rest.length, "moved with it")} Press Control Z or Command Z to undo.`;
    case "undo":
      return `Undid the change to ${label}: back to ${range(first.before)}.${others(rest.length, "moved back")}`;
    case "redo":
      return `Redid the change to ${label}: ${range(first.after)}.${others(rest.length, "moved with it")}`;
  }
}
