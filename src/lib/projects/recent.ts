import { prisma } from "@/lib/db/client";

/**
 * When each project was last touched BY THIS USER, within a window.
 *
 * The Overview used to list the org's six active projects, which is a property
 * of the org rather than of you — so the teaser whose whole job is to be a
 * jumping-off point could show six projects you never open. Feedback d5c10944:
 * "it just shows Active Projects, and i don't even normally use any of the six
 * it's showing".
 *
 * Derived from activity already recorded, so there is no new write path and no
 * visit tracking to add: `activities` carries `userId` and `createdAt`, and the
 * project comes via the work item. The two sets were confirmed to diverge in
 * practice before this was built: a person's recent projects are a strict and
 * much smaller subset of the org's active ones.
 *
 * Deliberately NOT cached and deliberately NOT merged into
 * `getActiveProjectsForOrg`: that one is `"use cache"` keyed per ORG and its
 * contract says it must not vary by actor, because varying it would either leak
 * one person's view to another or destroy the cache. This is the per-request
 * per-user half; callers combine the two.
 */
export async function recentProjectTouchesForUser(
  orgId: string,
  userId: string,
  sinceHours: number,
): Promise<Map<string, Date>> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

  // The most recent N activities, not every activity in the window: we only
  // need WHICH projects were touched and when, and a busy month is hundreds of
  // rows per person. Ordered desc so the cap keeps the newest.
  const activities = await prisma.activity.findMany({
    where: { orgId, userId, createdAt: { gte: since }, workItemId: { not: null } },
    select: { workItemId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  if (activities.length === 0) return new Map();

  const itemIds = [...new Set(activities.map((a) => a.workItemId!))];
  const items = await prisma.workItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, projectId: true },
  });
  const projectOf = new Map(items.map((i) => [i.id, i.projectId]));

  // First write wins: `activities` came back newest-first.
  const touched = new Map<string, Date>();
  for (const a of activities) {
    const projectId = projectOf.get(a.workItemId!);
    if (projectId && !touched.has(projectId)) touched.set(projectId, a.createdAt);
  }
  return touched;
}

/** The windows the Overview offers, and the one it starts on. */
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
