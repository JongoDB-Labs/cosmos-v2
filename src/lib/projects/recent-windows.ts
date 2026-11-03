/**
 * The windows "Recent projects" offers, and how a URL param maps onto one.
 *
 * Deliberately free of any database import: the window picker is a client
 * component, so anything it imports is bundled for the browser. Living beside
 * `recentProjectTouchesForUser` in `./recent` once pulled the Prisma pg driver
 * into the client bundle and broke `next build` on `util/types` — vitest and
 * tsc both pass in that state, because neither walks a bundle graph.
 */
export const RECENT_WINDOWS = [
  { key: "24h", label: "Last 24 hours", hours: 24 },
  { key: "7d", label: "Last 7 days", hours: 24 * 7 },
  { key: "30d", label: "Last 30 days", hours: 24 * 30 },
] as const;

export type RecentWindowKey = (typeof RECENT_WINDOWS)[number]["key"];
export const DEFAULT_RECENT_WINDOW: RecentWindowKey = "7d";

/** A window key from a URL param, falling back to the default for anything else. */
export function windowFromParam(value: string | undefined): RecentWindowKey {
  return RECENT_WINDOWS.some((w) => w.key === value)
    ? (value as RecentWindowKey)
    : DEFAULT_RECENT_WINDOW;
}

export function hoursForWindow(key: RecentWindowKey): number {
  return RECENT_WINDOWS.find((w) => w.key === key)!.hours;
}
