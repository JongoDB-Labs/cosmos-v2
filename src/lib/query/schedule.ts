/**
 * Filter subscription schedules (query design §12.4): five-field cron
 * (`minute hour day-of-month month day-of-week`) read in the subscription's
 * IANA time zone, with the minute a single number so nothing runs more than
 * once an hour.
 *
 * Small on purpose: `*`, lists, ranges and steps (`*\/2`, `1-5`, `8,12,17`),
 * day-of-week 0–7 with 0 and 7 both Sunday, and the classic rule that when
 * both day fields are restricted, either one matching is enough.
 *
 * Pure and client-safe: the Subscribe dialog shows the next run with it.
 */

export interface Schedule {
  minute: number;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Both day fields restricted: match either (cron's OR rule). */
  dayOr: boolean;
}

export const DEFAULT_CRON = "0 8 * * 1-5";

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

function parseField(text: string, f: (typeof FIELDS)[number]): { set: Set<number>; star: boolean } | string {
  const set = new Set<number>();
  let star = false;
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return `The ${f.name} "${part}" isn't a number, range or step.`;
    const step = m[4] ? Number(m[4]) : 1;
    if (step < 1) return `The ${f.name} step must be at least 1.`;
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      [lo, hi] = [f.min, f.max];
      if (!m[4]) star = true;
    } else {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? f.max : lo;
    }
    if (lo < f.min || hi > f.max || lo > hi) return `The ${f.name} must be between ${f.min} and ${f.max}.`;
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, star };
}

/** A schedule, or why the text isn't one. */
export function parseSchedule(cron: string): Schedule | { error: string } {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { error: "A schedule has five fields: minute hour day-of-month month day-of-week." };
  if (!/^\d+$/.test(parts[0])) return { error: "The minute must be a single number, so it runs at most once an hour." };
  const out = parts.map((p, i) => parseField(p, FIELDS[i]));
  const bad = out.find((o): o is string => typeof o === "string");
  if (bad) return { error: bad };
  const [min, hour, dom, month, dow] = out as { set: Set<number>; star: boolean }[];
  const weekdays = new Set([...dow.set].map((d) => d % 7));
  return {
    minute: [...min.set][0],
    hours: hour.set,
    days: dom.set,
    months: month.set,
    weekdays,
    dayOr: !dom.star && !dow.star,
  };
}

/** The wall-clock fields of an instant in a time zone. */
function local(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
  };
}

function matches(s: Schedule, l: ReturnType<typeof local>): boolean {
  if (l.minute !== s.minute || !s.hours.has(l.hour) || !s.months.has(l.month)) return false;
  const dom = s.days.has(l.day);
  const dow = s.weekdays.has(l.weekday);
  return s.dayOr ? dom || dow : dom && dow;
}

const MINUTE = 60_000;
/** How far ahead to look before calling a schedule "never". */
const HORIZON_MS = 366 * 24 * 60 * MINUTE;

/**
 * The first run strictly after `after`, or null when there's none within a
 * year (`0 8 31 2 *`). Walks quarter-hours, since every zone's offset is a
 * multiple of 15 minutes; DST gaps skip a run and overlaps run once.
 */
export function nextRun(s: Schedule, timeZone: string, after: Date): Date | null {
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  // First instant at or after `t` whose local minute is the schedule's.
  for (let i = 0; i < 60 && local(new Date(t), timeZone).minute !== s.minute; i++) t += MINUTE;
  const end = after.getTime() + HORIZON_MS;
  for (; t <= end; t += 15 * MINUTE) {
    const l = local(new Date(t), timeZone);
    if (matches(s, l)) return new Date(t);
  }
  return null;
}

/** Validate a cron + zone together: the error, or the next run. */
export function checkSchedule(cron: string, timeZone: string, now = new Date()): { next: Date } | { error: string } {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return { error: `"${timeZone}" isn't a time zone.` };
  }
  const s = parseSchedule(cron);
  if ("error" in s) return s;
  const next = nextRun(s, timeZone, now);
  return next ? { next } : { error: "That schedule never runs in the next year." };
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The presets the Subscribe dialog offers, and how it describes a schedule. */
export function describeSchedule(cron: string): string {
  const s = parseSchedule(cron);
  if ("error" in s) return cron;
  const hours = [...s.hours].sort((a, b) => a - b);
  const at = hours.length === 1 ? ` at ${String(hours[0]).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}` : "";
  const parts = cron.trim().split(/\s+/);
  if (!at || parts[3] !== "*") return `Custom (${cron})`;
  if (parts[2] === "*" && parts[4] === "*") return `Every day${at}`;
  if (parts[2] === "*" && parts[4] === "1-5") return `Weekdays${at}`;
  if (parts[2] === "*" && s.weekdays.size === 1) return `Every ${DAY_NAMES[[...s.weekdays][0]]}${at}`;
  if (parts[4] === "*" && s.days.size === 1) return `Monthly on day ${[...s.days][0]}${at}`;
  return `Custom (${cron})`;
}

export type Preset = "weekdays" | "daily" | "weekly" | "monthly" | "custom";

/** The cron a Subscribe-dialog preset and an "HH:MM" time stand for. */
export function presetCron(preset: Preset, time: string, weekday: number, monthDay: number, custom: string): string {
  const [h, m] = time.split(":").map(Number);
  const at = `${Number.isFinite(m) ? m : 0} ${Number.isFinite(h) ? h : 8}`;
  switch (preset) {
    case "weekdays":
      return `${at} * * 1-5`;
    case "daily":
      return `${at} * * *`;
    case "weekly":
      return `${at} * * ${weekday}`;
    case "monthly":
      return `${at} ${monthDay} * *`;
    default:
      return custom.trim();
  }
}
