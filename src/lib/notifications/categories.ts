/**
 * Notification categories — a stable, user-facing grouping of the raw
 * `Notification.type` strings emitted across the app.
 *
 * Every `createNotification({ type })` caller uses a "<domain>.<event>"
 * convention, e.g. "work_item.assigned", "comment.added", "comment.mentioned",
 * "note.mentioned", "chat.mentioned", "chat.dm", "chat.message",
 * "meeting.invited", "feedback.delivered", "delivery.shipped",
 * "delivery.parked". So most categories match on the domain prefix.
 *
 * "Mentions" is intentionally cross-cutting — any "*.mentioned" event —
 * because being @-mentioned is the thing users most want to filter on,
 * regardless of which surface it happened on.
 *
 * This is a pure module (no server-only imports) so it can be shared by both
 * the client notifications feed (filter chips, per-row labels) and the server
 * route (translating a category into a Prisma `where.type` fragment).
 */

export interface NotificationCategoryDef {
  key: string;
  label: string;
  /** The type must start with this "<domain>." prefix. */
  prefix?: string;
  /** ...or end with this ".<event>" suffix (used by the cross-cutting Mentions). */
  suffix?: string;
}

export const NOTIFICATION_CATEGORIES: NotificationCategoryDef[] = [
  { key: "mention", label: "Mentions", suffix: ".mentioned" },
  { key: "comment", label: "Comments", prefix: "comment." },
  { key: "assignment", label: "Assignments", prefix: "work_item." },
  { key: "chat", label: "Chat", prefix: "chat." },
  { key: "note", label: "Notes", prefix: "note." },
  { key: "meeting", label: "Meetings", prefix: "meeting." },
  { key: "delivery", label: "Delivery", prefix: "delivery." },
  { key: "feedback", label: "Feedback", prefix: "feedback." },
];

/** True when `type` belongs to the category identified by `key`. */
export function categoryMatchesType(key: string, type: string): boolean {
  const def = NOTIFICATION_CATEGORIES.find((c) => c.key === key);
  if (!def) return false;
  if (def.suffix) return type.endsWith(def.suffix);
  if (def.prefix) return type.startsWith(def.prefix);
  return false;
}

/**
 * A Prisma `where.type` fragment for the given category, or `null` when the key
 * is missing / "all" (meaning "don't filter by type").
 */
export function categoryTypeFilter(
  key: string | null | undefined,
): { startsWith: string } | { endsWith: string } | null {
  if (!key || key === "all") return null;
  const def = NOTIFICATION_CATEGORIES.find((c) => c.key === key);
  if (!def) return null;
  if (def.suffix) return { endsWith: def.suffix };
  if (def.prefix) return { startsWith: def.prefix };
  return null;
}

/**
 * A short, human label for a single notification's type — used for the per-row
 * category badge. Prefers the specific "Mention" label over the domain, then
 * falls back to humanizing an unknown "<domain>.<event>" prefix so new event
 * types still render something sensible.
 */
export function notificationTypeLabel(type: string): string {
  if (type.endsWith(".mentioned")) return "Mention";
  const def = NOTIFICATION_CATEGORIES.find(
    (c) => c.prefix && type.startsWith(c.prefix),
  );
  // "Comments" -> "Comment", "Notes" -> "Note"; "Delivery"/"Feedback" unchanged.
  if (def) return def.label.replace(/s$/, "");
  const domain = type.split(".")[0] ?? type;
  if (!domain) return "Update";
  return domain.charAt(0).toUpperCase() + domain.slice(1).replace(/_/g, " ");
}
