/**
 * SERVER-ONLY: what a spreadsheet row MEANS to the program calendar.
 *
 * The generic importer (src/lib/import/entity-import.ts) owns the mechanics —
 * mapping, coercion, create-or-update by natural key — and delegates the three
 * things that are specific to this entity:
 *
 *   - DATES. A calendar date is a date, not an instant. The sheet's
 *     `Start date` + `Start time` are a WALL CLOCK in the event's own zone, and
 *     the stored columns are instants, so the conversion has to name a zone.
 *     Doing it with `new Date("10/27/2026")` would silently use the SERVER's
 *     zone, which is UTC in CI and the container and something else on a
 *     laptop — the row would land on a different day depending on where the
 *     import ran. Everything here reads y/m/d literally and converts through
 *     `zonedInstant`, then hands the pair to `normalizeRange` so the
 *     inclusive-end rule stays in exactly one place.
 *   - LOOKUPS. Category, owner and deliverable arrive as NAMES.
 *   - WRITES. The create/update shapes, including the category an import may
 *     have to create.
 *
 * Nothing here is reachable from the browser: `entity-fields.ts` holds the
 * client-safe half of the contract.
 */
import type { EventRecurrence } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { DEFAULT_CATEGORIES } from "./categories";
import { normalizeRange } from "./time";

/** Mirrors `ProgramEvent.timeZone`'s column default (and the service's own
 *  fallback) — an event with no zone is assumed to be in the program's. */
export const DEFAULT_EVENT_TIME_ZONE = "America/New_York";

/** The row shape the engine hands us: a mapped, coerced row it can still fail. */
export interface ImportableRow {
  fields: Record<string, unknown>;
  warnings: string[];
  error: string | null;
}

// ── Time zones ───────────────────────────────────────────────────────────────

/** Normalising key for a zone label: case, spaces and punctuation all go. */
const zoneKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Spellings a person writes in a spreadsheet, and the IANA zone each means.
 *
 * This is not politeness: `event-chip.tsx` passes the stored value straight to
 * `Intl.DateTimeFormat({ timeZone })`, which THROWS on an unknown zone. Storing
 * "Eastern (ET)" verbatim — which is what the real export carries — would take
 * the calendar down at render rather than show a wrong time.
 */
const ZONE_ALIASES: Record<string, string> = {
  eastern: "America/New_York",
  easterntime: "America/New_York",
  easternet: "America/New_York",
  easterntimeuscanada: "America/New_York",
  et: "America/New_York",
  est: "America/New_York",
  edt: "America/New_York",
  central: "America/Chicago",
  centraltime: "America/Chicago",
  centralct: "America/Chicago",
  ct: "America/Chicago",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  mountain: "America/Denver",
  mountaintime: "America/Denver",
  mt: "America/Denver",
  mst: "America/Denver",
  mdt: "America/Denver",
  pacific: "America/Los_Angeles",
  pacifictime: "America/Los_Angeles",
  pacificpt: "America/Los_Angeles",
  pt: "America/Los_Angeles",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  alaska: "America/Anchorage",
  hawaii: "Pacific/Honolulu",
  gmt: "UTC",
  utc: "UTC",
  zulu: "UTC",
  z: "UTC",
};

/** Is this a zone `Intl` will actually accept? */
function isIanaZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A sheet's zone label as an IANA zone, or null when it means nothing. */
export function resolveTimeZone(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (isIanaZone(value)) return value;
  return ZONE_ALIASES[zoneKey(value)] ?? null;
}

/** Milliseconds `timeZone` is ahead of UTC at `at` (DST included). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    part("year"), part("month") - 1, part("day"),
    // Some environments render midnight as hour 24 even under h23.
    part("hour") % 24, part("minute"), part("second"),
  );
  return asUtc - at.getTime();
}

/**
 * The instant at which it is `y-m-d hh:mm` in `timeZone`.
 *
 * Offset-then-correct: the zone's offset is itself a function of the instant,
 * so the first guess is measured at the wrong moment near a DST boundary. The
 * second measurement settles it (and for a wall clock inside a spring-forward
 * gap, which does not exist, it lands on the instant just after the jump).
 */
export function zonedInstant(
  y: number, m: number, d: number, hh: number, mm: number, timeZone: string,
): Date {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const first = zoneOffsetMs(new Date(wall), timeZone);
  let t = wall - first;
  const second = zoneOffsetMs(new Date(t), timeZone);
  if (second !== first) t = wall - second;
  return new Date(t);
}

// ── Reading a sheet's dates and times ────────────────────────────────────────

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/** Two-digit years: a calendar sheet is about now, not 1926. */
const fullYear = (y: number) => (y >= 100 ? y : y + 2000);

/**
 * A date cell as plain calendar parts — never a `Date`, so no zone is implied.
 *
 * Handles the three shapes the real files and their neighbours use: ISO
 * (`2026-10-01`, optionally with a time suffix), US slashes (`10/27/2026`), and
 * a month name (`9-Nov-2026`, `Nov 9, 2026`).
 */
export function parseSheetDate(raw: string): { y: number; m: number; d: number } | null {
  const value = raw.trim();
  if (!value) return null;

  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]|$)/);
  if (iso) return part3(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = value.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (slash) return part3(fullYear(Number(slash[3])), Number(slash[1]), Number(slash[2]));

  const dmy = value.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s,]*(\d{2,4})$/);
  if (dmy) {
    const m = MONTHS.indexOf(dmy[2].slice(0, 3).toLowerCase());
    if (m >= 0) return part3(fullYear(Number(dmy[3])), m + 1, Number(dmy[1]));
  }

  const mdy = value.match(/^([A-Za-z]{3,})[-\s]+(\d{1,2})[-\s,]+(\d{2,4})$/);
  if (mdy) {
    const m = MONTHS.indexOf(mdy[1].slice(0, 3).toLowerCase());
    if (m >= 0) return part3(fullYear(Number(mdy[3])), m + 1, Number(mdy[2]));
  }

  return null;
}

/** Range-check the parts so "13/40/2026" is a miss, not a rolled-over date. */
function part3(y: number, m: number, d: number): { y: number; m: number; d: number } | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** `2026-11-09` for a set of calendar parts. */
export function dayKey(p: { y: number; m: number; d: number }): string {
  return `${String(p.y).padStart(4, "0")}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** A time cell as wall-clock parts: `09:00`, `9:30 AM`, `1530`, `4 pm`. */
export function parseSheetTime(raw: string): { hh: number; mm: number } | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const m = value.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3];
  if (meridiem) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (meridiem === "pm" ? 12 : 0);
  }
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

/**
 * The calendar day an event "is on", for the title + date natural key.
 *
 * All-day events are stored as UTC midnights, so their day is their UTC day.
 * A timed event is an instant, and the day it belongs to is the day in ITS OWN
 * zone — a 9pm Eastern meeting is stored as the next UTC day, and reading it
 * back in UTC would make a re-import of the very same sheet row look new.
 */
export function eventDayKey(startsAt: Date, allDay: boolean, timeZone: string): string {
  if (allDay) {
    return dayKey({
      y: startsAt.getUTCFullYear(), m: startsAt.getUTCMonth() + 1, d: startsAt.getUTCDate(),
    });
  }
  const zone = isIanaZone(timeZone) ? timeZone : DEFAULT_EVENT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(startsAt);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return dayKey({ y: part("year"), m: part("month"), d: part("day") });
}

// ── A row's stored range ─────────────────────────────────────────────────────

const text = (fields: Record<string, unknown>, key: string): string =>
  typeof fields[key] === "string" ? (fields[key] as string).trim() : "";

export interface EventRange {
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  timeZone: string;
}

/**
 * What a row's date/time columns store, or null when it has no readable start
 * date (which the engine turns into a per-row error).
 *
 * `current` is the event being UPDATED, if any: a sheet that maps dates but not
 * `All day` must not flip an existing all-day event into a midnight-to-midnight
 * timed one.
 */
export function eventRangeFromRow(
  fields: Record<string, unknown>,
  current?: { allDay: boolean; timeZone: string },
): { range: EventRange; warnings: string[] } | null {
  const warnings: string[] = [];
  const start = parseSheetDate(text(fields, "startDate"));
  if (!start) return null;
  const endRaw = text(fields, "endDate");
  const end = parseSheetDate(endRaw) ?? start;
  if (endRaw && !parseSheetDate(endRaw)) {
    warnings.push(`End date: "${endRaw}" is not a date — the start date was used`);
  }

  const zoneRaw = text(fields, "timeZone");
  const resolved = zoneRaw ? resolveTimeZone(zoneRaw) : null;
  if (zoneRaw && !resolved) {
    warnings.push(`Time zone: "${zoneRaw}" is not a time zone — used ${current?.timeZone ?? DEFAULT_EVENT_TIME_ZONE}`);
  }
  const timeZone = resolved ?? current?.timeZone ?? DEFAULT_EVENT_TIME_ZONE;

  const startTimeRaw = text(fields, "startTime");
  const endTimeRaw = text(fields, "endTime");
  // An explicit All day column wins. Without one, a row carrying a start time
  // is timed and a row carrying only dates is all-day — which is what a
  // calendar sheet with an empty time column means.
  const allDay =
    typeof fields.allDay === "boolean"
      ? fields.allDay
      : startTimeRaw
        ? false
        : (current?.allDay ?? true);

  if (allDay) {
    // UTC midnights; `normalizeRange` snaps them and makes the end exclusive.
    const range = normalizeRange({
      startsAt: new Date(Date.UTC(start.y, start.m - 1, start.d)),
      endsAt: new Date(Date.UTC(end.y, end.m - 1, end.d)),
      allDay: true,
    });
    return { range: { ...range, allDay: true, timeZone }, warnings };
  }

  const startTime = parseSheetTime(startTimeRaw);
  if (startTimeRaw && !startTime) {
    warnings.push(`Start time: "${startTimeRaw}" is not a time — used midnight`);
  }
  const endTime = parseSheetTime(endTimeRaw);
  if (endTimeRaw && !endTime) {
    warnings.push(`End time: "${endTimeRaw}" is not a time — used the start time`);
  }
  const from = startTime ?? { hh: 0, mm: 0 };
  const to = endTime ?? from;
  const range = normalizeRange({
    startsAt: zonedInstant(start.y, start.m, start.d, from.hh, from.mm, timeZone),
    endsAt: zonedInstant(end.y, end.m, end.d, to.hh, to.mm, timeZone),
    allDay: false,
  });
  return { range: { ...range, allDay: false, timeZone }, warnings };
}

// ── Lookups: a NAME in the sheet, an id in the column ────────────────────────

const lower = (s: string) => s.trim().toLowerCase();

/** First wins, so a duplicated name resolves to the same row every run. */
function firstByName<T extends { id: string }>(rows: T[], nameOf: (r: T) => string | null | undefined) {
  const byName = new Map<string, string>();
  for (const r of rows) {
    const key = lower(nameOf(r) ?? "");
    if (key && !byName.has(key)) byName.set(key, r.id);
  }
  return byName;
}

/**
 * Turn this batch's category / owner / deliverable NAMES into ids.
 *
 * Runs for `validate` as well as `commit`, so the preview can say "there is no
 * deliverable called that" — which is the whole point of a preview. Same shape
 * as the deliverable importer's sprint lookup: the field is left blank, the row
 * still imports, and the warning names the cell.
 *
 * A category that does not exist is NOT a warning: it is created at commit
 * time, like a vendor import's partner. Resolving it here only avoids a lookup
 * per row later.
 *
 * Also the one place a row can be REJECTED: an unreadable start date is
 * blocking, because every other column describes an event that has no date.
 *
 * SCOPE: org-wide, and deliberately NOT filtered by project visibility the way
 * `assertReferencesInOrg` filters a user-SUPPLIED id. These ids are not
 * supplied — they are resolved from names, inside this org, for a caller
 * holding ORG_IMPORT, which the stock roles grant only to OWNER/ADMIN: the same
 * roles `isOrgAdministrator` already lets read every project. A work role CAN
 * hand ORG_IMPORT to an ordinary member, and for that case this is wider than
 * the service's check — a team on a project they cannot open would resolve, and
 * the lane label renders that team's name. Narrowing it needs the caller's
 * AuthContext, which the engine's ctx does not carry.
 */
export async function resolveProgramEventLookups(
  orgId: string,
  rows: ImportableRow[],
): Promise<void> {
  for (const row of rows) {
    if (row.error) continue;
    const raw = text(row.fields, "startDate");
    if (raw && !parseSheetDate(raw)) {
      row.error = `Start date: "${raw}" is not a date`;
    }
  }

  const live = rows.filter((r) => !r.error);

  const categoryNames = new Set(live.map((r) => lower(text(r.fields, "category"))).filter(Boolean));
  if (categoryNames.size) {
    // Archived categories count: `@@unique([orgId, name])` means re-creating
    // one would fail outright, and an event keeps its category either way.
    const existing = await prisma.eventCategory.findMany({
      where: { orgId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    const byName = firstByName(existing, (c) => c.name);
    for (const row of live) {
      const id = byName.get(lower(text(row.fields, "category")));
      if (id) row.fields.categoryId = id;
    }
  }

  const ownerNames = new Set(live.map((r) => lower(text(r.fields, "owner"))).filter(Boolean));
  if (ownerNames.size) {
    // A team OR a person, team first — the same precedence `oneOwner` applies
    // in the service, so an import cannot produce a two-owner event the UI
    // would have to pick a lane for.
    const [teams, members] = await Promise.all([
      prisma.team.findMany({ where: { orgId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      prisma.orgMember.findMany({
        where: { orgId, removedAt: null },
        select: { id: true, user: { select: { displayName: true, email: true } } },
        orderBy: { id: "asc" },
      }),
    ]);
    const teamByName = firstByName(teams, (t) => t.name);
    const memberByName = firstByName(members, (m) => m.user.displayName);
    const memberByEmail = firstByName(members, (m) => m.user.email);
    for (const row of live) {
      const name = text(row.fields, "owner");
      if (!name) continue;
      const teamId = teamByName.get(lower(name));
      if (teamId) {
        row.fields.ownerTeamId = teamId;
        continue;
      }
      const memberId = memberByName.get(lower(name)) ?? memberByEmail.get(lower(name));
      if (memberId) {
        row.fields.ownerMemberId = memberId;
        continue;
      }
      row.warnings.push(`Owner: "${name}" is not a team or member of this organization — left unassigned`);
    }
  }

  const deliverableTitles = new Set(live.map((r) => lower(text(r.fields, "deliverable"))).filter(Boolean));
  if (deliverableTitles.size) {
    const deliverables = await prisma.deliverable.findMany({
      where: { orgId },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
    });
    const byTitle = firstByName(deliverables, (d) => d.title);
    for (const row of live) {
      const title = text(row.fields, "deliverable");
      if (!title) continue;
      const id = byTitle.get(lower(title));
      if (id) row.fields.deliverableId = id;
      else row.warnings.push(`Deliverable: "${title}" is not a deliverable in this organization — left unlinked`);
    }
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * The category id for a row, creating the category when the org has none by
 * that name.
 *
 * `listCategories` seeds an org's defaults only when it has ZERO categories, so
 * creating one here first would strand an org without them forever. The tint
 * comes from those same defaults rather than a new colour, chosen by a stable
 * hash of the name so a re-import does not repaint it.
 */
async function categoryIdFor(
  orgId: string,
  fields: Record<string, unknown>,
  cache: Map<string, string>,
): Promise<string> {
  const existing = fields.categoryId;
  if (typeof existing === "string" && existing) return existing;

  const name = text(fields, "category");
  const key = lower(name);
  const cached = cache.get(key);
  if (cached) return cached;

  const found = await prisma.eventCategory.findFirst({
    where: { orgId, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (found) {
    cache.set(key, found.id);
    return found.id;
  }

  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  const seed = DEFAULT_CATEGORIES[hash % DEFAULT_CATEGORIES.length];
  const max = await prisma.eventCategory.aggregate({ where: { orgId }, _max: { sortOrder: true } });
  const created = await prisma.eventCategory.create({
    data: {
      orgId,
      name,
      tintRgb: seed.tintRgb,
      tintAlpha: seed.tintAlpha,
      textColor: seed.textColor,
      sortOrder: (max._max.sortOrder ?? 0) + 1,
    },
    select: { id: true },
  });
  cache.set(key, created.id);
  return created.id;
}

const str = (fields: Record<string, unknown>, key: string): string | null =>
  typeof fields[key] === "string" ? (fields[key] as string) : null;
const bool = (fields: Record<string, unknown>, key: string): boolean | null =>
  typeof fields[key] === "boolean" ? (fields[key] as boolean) : null;

/**
 * Create one event.
 *
 * `projectId` is null: an org-wide import has no project to attach to, and an
 * event with no project is visible to the whole org — which is what a program
 * calendar imported across the organisation is.
 */
export async function createProgramEventRow(
  ctx: { orgId: string; userId: string },
  fields: Record<string, unknown>,
  cache: Map<string, string>,
): Promise<void> {
  const built = eventRangeFromRow(fields);
  if (!built) throw new Error("Start date is missing or unreadable");
  const { range } = built;

  await prisma.programEvent.create({
    data: {
      orgId: ctx.orgId,
      createdById: ctx.userId,
      projectId: null,
      categoryId: await categoryIdFor(ctx.orgId, fields, cache),
      title: str(fields, "title")!,
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      allDay: range.allDay,
      timeZone: range.timeZone,
      location: str(fields, "location"),
      ownerTeamId: str(fields, "ownerTeamId"),
      // One owner, team first: a row that resolved to a team never also carries
      // a member id, because the lookup stops at the first hit.
      ownerMemberId: str(fields, "ownerTeamId") ? null : str(fields, "ownerMemberId"),
      attendees: str(fields, "attendees") ?? "",
      recurrence: (str(fields, "recurrence") as EventRecurrence | null) ?? "NONE",
      deliverableId: str(fields, "deliverableId"),
      customerAttending: bool(fields, "customerAttending") ?? false,
      description: str(fields, "description") ?? "",
      showOnDashboard: bool(fields, "showOnDashboard") ?? false,
      externalId: str(fields, "externalId"),
    },
  });
}

/**
 * Update one event with only the columns this import mapped.
 *
 * The dates are the exception to "one column, one field": `startsAt`/`endsAt`
 * are computed from four columns plus `All day`, so they move together or not
 * at all — and only when the row actually supplies a start date. The event's
 * CURRENT all-day flag and zone are the fallbacks, so a sheet that carries only
 * dates cannot silently retime an all-day event.
 */
export async function updateProgramEventRow(
  ctx: { orgId: string; userId: string },
  id: string,
  fields: Record<string, unknown>,
  cache: Map<string, string>,
): Promise<void> {
  const data: Record<string, unknown> = {};
  const put = (column: string, value: unknown) => {
    if (value !== null && value !== undefined) data[column] = value;
  };

  put("title", str(fields, "title"));
  put("location", str(fields, "location"));
  put("attendees", str(fields, "attendees"));
  put("recurrence", str(fields, "recurrence"));
  put("description", str(fields, "description"));
  put("externalId", str(fields, "externalId"));
  put("customerAttending", bool(fields, "customerAttending"));
  put("showOnDashboard", bool(fields, "showOnDashboard"));
  put("deliverableId", str(fields, "deliverableId"));
  if (text(fields, "category")) put("categoryId", await categoryIdFor(ctx.orgId, fields, cache));
  if (text(fields, "owner")) {
    const teamId = str(fields, "ownerTeamId");
    const memberId = str(fields, "ownerMemberId");
    // Only when the name RESOLVED: an unresolvable owner is a warning, and
    // clearing the existing one would turn that warning into data loss.
    if (teamId || memberId) {
      data.ownerTeamId = teamId;
      data.ownerMemberId = teamId ? null : memberId;
    }
  }

  if (text(fields, "startDate")) {
    const current = await prisma.programEvent.findUnique({
      where: { id },
      select: { allDay: true, timeZone: true },
    });
    const built = eventRangeFromRow(fields, current ?? undefined);
    if (built) {
      data.startsAt = built.range.startsAt;
      data.endsAt = built.range.endsAt;
      data.allDay = built.range.allDay;
      data.timeZone = built.range.timeZone;
    }
  }

  if (Object.keys(data).length) await prisma.programEvent.update({ where: { id }, data });
}
