import { endOf, startOf } from "@/lib/query/dates";

/** The meetings list's sections. */
export interface MeetingGroups<M> {
  today: M[];
  thisWeek: M[];
  upcoming: M[];
  past: M[];
}

/**
 * Sort meetings into the list's sections by the viewer's own calendar: today;
 * the rest of this week (Monday to Sunday, earlier days included); upcoming,
 * after this week; and past, before it. Everything outside this week used to
 * land in Past, next month's meetings included.
 *
 * `tz` is the viewer's zone, so the boundaries are their midnight and their
 * Monday, wherever the code runs. Upcoming runs soonest first; the other
 * sections newest first, as the list always has.
 */
export function groupMeetingsByWhen<M extends { meetingDate: string | Date }>(
  meetings: readonly M[],
  now: Date,
  tz: string,
): MeetingGroups<M> {
  const dayStart = startOf("day", now, tz).getTime();
  const dayEnd = endOf("day", now, tz).getTime();
  const weekStart = startOf("week", now, tz).getTime();
  const weekEnd = endOf("week", now, tz).getTime();
  const at = (m: M) => new Date(m.meetingDate).getTime();

  const groups: MeetingGroups<M> = { today: [], thisWeek: [], upcoming: [], past: [] };
  for (const m of [...meetings].sort((a, b) => at(b) - at(a))) {
    const t = at(m);
    if (t >= dayStart && t <= dayEnd) groups.today.push(m);
    else if (t >= weekStart && t <= weekEnd) groups.thisWeek.push(m);
    else if (t > weekEnd) groups.upcoming.push(m);
    else groups.past.push(m);
  }
  groups.upcoming.reverse();
  return groups;
}
