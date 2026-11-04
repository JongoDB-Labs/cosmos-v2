/**
 * Internal time: hours a person spent on the business rather than on a
 * project — overhead, business development, professional development.
 *
 * An org's categories live on Organization.settings.time.internalCategories,
 * as text. Text rather than an enum because what a firm calls its internal
 * time is its own business, and a closed list would be wrong for the second
 * org that used it. Unset means the defaults below; an EMPTY list is a real
 * choice ("we don't categorise internal time") and turns the picker off.
 *
 * An entry carries the category as it was named when it was logged, so
 * renaming a category later does not rewrite last quarter's report.
 *
 * Client-safe: no server imports.
 */

const DEFAULT_INTERNAL_CATEGORIES = [
  "Overhead",
  "Business development",
  "Professional development",
] as const;

export const MAX_INTERNAL_CATEGORIES = 30;
export const MAX_INTERNAL_CATEGORY_LENGTH = 60;

export function internalCategories(settings: unknown): string[] {
  const list = ((settings ?? {}) as { time?: { internalCategories?: unknown } }).time?.internalCategories;
  if (!Array.isArray(list) || !list.every((c) => typeof c === "string")) {
    return [...DEFAULT_INTERNAL_CATEGORIES];
  }
  return list as string[];
}

/** Trim, drop blanks and duplicates (case-insensitively), keep the order given. */
export function normalizeInternalCategories(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const c = raw.trim();
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    out.push(c);
  }
  return out;
}

export type InternalCategoryCheck =
  | { ok: true; category: string | null }
  | { ok: false; reason: string };

/**
 * Is this the internal category an entry may be written with?
 *
 * Internal time is, by definition, not project time: an entry carrying both
 * would be counted twice in any report that splits the two, so the pair is
 * refused rather than silently resolved one way.
 *
 * `previous` is the category the entry already has. Keeping it is always
 * allowed, even if the org has since renamed or removed it — otherwise the
 * rename would make every old entry uneditable.
 */
export function checkInternalCategory(input: {
  category: string | null | undefined;
  projectId: string | null | undefined;
  allowed: readonly string[];
  previous?: string | null;
}): InternalCategoryCheck {
  const category = input.category?.trim() || null;
  if (category === null) return { ok: true, category: null };
  if (input.projectId) {
    return { ok: false, reason: "Internal time can't be logged against a project. Clear the project or the category." };
  }
  if (category === input.previous) return { ok: true, category };
  if (!input.allowed.includes(category)) {
    return { ok: false, reason: `"${category}" isn't one of this organization's internal time categories.` };
  }
  return { ok: true, category };
}

export interface SplittableEntry {
  hours: number;
  projectId: string | null;
  internalCategory?: string | null;
}

export interface TimeSplit {
  projectHours: number;
  internalHours: number;
  /** Neither a project nor an internal category: time nobody has placed yet. */
  unassignedHours: number;
  /** Internal hours per category, in the org's configured order, then any others A-Z. */
  byCategory: { category: string; hours: number }[];
}

/**
 * Project time and internal time, reported separately.
 *
 * Every hour lands in exactly one of the three buckets, so the three add up to
 * the total — an entry with both a project and a category (which the write
 * path refuses, but older or imported data might hold) counts as project time,
 * because that is where it was charged.
 */
export function splitTime(entries: readonly SplittableEntry[], order: readonly string[] = []): TimeSplit {
  let projectHours = 0;
  let internalHours = 0;
  let unassignedHours = 0;
  const per = new Map<string, number>();
  for (const e of entries) {
    if (e.projectId) {
      projectHours += e.hours;
    } else if (e.internalCategory) {
      internalHours += e.hours;
      per.set(e.internalCategory, (per.get(e.internalCategory) ?? 0) + e.hours);
    } else {
      unassignedHours += e.hours;
    }
  }
  const rank = (c: string) => {
    const i = order.indexOf(c);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const byCategory = [...per.entries()]
    .map(([category, hours]) => ({ category, hours }))
    .sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category));
  return { projectHours, internalHours, unassignedHours, byCategory };
}
