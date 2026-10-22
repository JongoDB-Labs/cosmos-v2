import { z } from "zod";
import { DEFAULT_FEED_OPTIONS, type FeedOptions } from "./feed-events";

/** FeedOptions as the API accepts them: every switch, explicitly. */
export const feedOptionsSchema = z.object({
  workItems: z.boolean(),
  meetings: z.boolean(),
  intervals: z.boolean(),
  busyOnly: z.boolean(),
}) satisfies z.ZodType<FeedOptions>;

/**
 * COSMOS-202: calendar feeds are OFF for an org until an admin with
 * INTEGRATION_MANAGE turns them on. A subscribed feed is fetched by the
 * calendar provider's servers, so every title in it leaves this system. Whether
 * that is acceptable is the organisation's decision, not each person's.
 * Stored on Organization.settings.calendarFeeds.
 */
export function calendarFeedsEnabled(settings: unknown): boolean {
  const s = (settings ?? {}) as { calendarFeeds?: { enabled?: unknown } };
  return s.calendarFeeds?.enabled === true;
}

export function withCalendarFeedsEnabled(settings: unknown, enabled: boolean): Record<string, unknown> {
  const s = { ...((settings ?? {}) as Record<string, unknown>) };
  s.calendarFeeds = { ...((s.calendarFeeds as Record<string, unknown>) ?? {}), enabled };
  return s;
}

/** Stored options, defaulted field by field so an old row never breaks a feed. */
export function readFeedOptions(json: unknown): FeedOptions {
  const o = (json ?? {}) as Partial<Record<keyof FeedOptions, unknown>>;
  const pick = (k: keyof FeedOptions) => (typeof o[k] === "boolean" ? (o[k] as boolean) : DEFAULT_FEED_OPTIONS[k]);
  return { workItems: pick("workItems"), meetings: pick("meetings"), intervals: pick("intervals"), busyOnly: pick("busyOnly") };
}
