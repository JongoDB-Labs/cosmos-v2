/**
 * Client-safe Teams-notification constants (FR 8a162fe7) — shared by the
 * server-side notifier (teams-notify.ts) and the settings toggles UI. No
 * server imports here.
 */
export type TeamsEvent =
  | "feedbackDelivered"
  | "itemCompleted"
  | "itemCreated"
  | "mentions"
  | "sprintStartEnd"
  | "dailyDigest";

/** User-approved defaults: the three high-signal events on, the noisy three off. */
export const TEAMS_NOTIFY_DEFAULTS: Record<TeamsEvent, boolean> = {
  feedbackDelivered: true,
  itemCompleted: true,
  sprintStartEnd: true,
  itemCreated: false,
  mentions: false,
  dailyDigest: false,
};

export const TEAMS_EVENT_LABELS: Record<TeamsEvent, string> = {
  feedbackDelivered: "Feedback delivered to the backlog",
  itemCompleted: "Work item completed",
  itemCreated: "Work item created",
  mentions: "@Mentions in chat",
  sprintStartEnd: "Sprint started / completed",
  dailyDigest: "Daily digest",
};

export const TEAMS_EVENTS = Object.keys(TEAMS_NOTIFY_DEFAULTS) as TeamsEvent[];

/** Minimal HTML escaping for user text interpolated into a Teams HTML body. */
export function escapeHtmlBasic(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
