// Week maths for the timesheet specs. These mirror `getWeekDates()` in the
// time-tracking component, so a change to the component's week boundary has to
// land here — in ONE place — rather than in every spec that navigates by week.

/** Monday of the week containing `d` — mirrors getWeekDates() in the component. */
export function mondayOf(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  x.setHours(0, 0, 0, 0);
  return x;
}

/** `YYYY-MM-DD` in LOCAL time — `toISOString()` would shift the day behind UTC. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
