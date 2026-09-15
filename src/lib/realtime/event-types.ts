/**
 * Every event name the server publishes over the org SSE stream.
 *
 * This list is not documentation — it is load-bearing. Only ONE tab per browser
 * opens the EventSource (the elected leader); every other tab receives events
 * rebroadcast from it over a BroadcastChannel. The leader binds a listener for
 * each name here, so **an event missing from this list is never bound, never
 * received, and never rebroadcast** — its feature's realtime silently does
 * nothing.
 *
 * That is not hypothetical. `ceremony.changed` was absent, and because the
 * leader is almost always the topbar's unread-badge subscriber (it mounts on
 * every dashboard page, ahead of any board), no listener for it existed on any
 * tab. A second facilitator watching a retro never saw a note appear.
 *
 * `realtime-event-coverage.arch.test.ts` diffs this against the names actually
 * published in `src/`, so the next one cannot drift in unnoticed.
 */
export const ALL_SERVER_EVENT_TYPES = [
  "chat.message.created",
  "chat.message.updated",
  "chat.message.deleted",
  "chat.message.streaming",
  "chat.reaction.added",
  "chat.reaction.removed",
  "chat.typing",
  "chat.presence.changed",
  "chat.read.receipt",
  "chat.unread.bumped",
  "chat.read.updated",
  "chat.pin.added",
  "chat.pin.removed",
  "chat.channel.joined",
  "chat.channel.left",
  "notification.created",
  "work-item.created",
  "work-item.updated",
  "work-item.deleted",
  "work-item-link.created",
  "work-item-link.deleted",
  "ceremony.changed",
  "org.created",
  "feedback.throttled",
  "feedback.gated",
  "feedback.flagged",
  "feedback.duplicate",
  "feedback.delivered",
  "settings.updated",
  "member.updated",
  "hello",
] as const;

export type ServerEventType = (typeof ALL_SERVER_EVENT_TYPES)[number];
