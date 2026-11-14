import { z } from "zod";
import { madeThroughRequiredIdp } from "@/lib/auth/api-key-policy";
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
 * Stored on Organization.settings.calendarFeeds, which the settings route
 * writes with patchOrgSettings (merging `enabled` into that key).
 */
export function calendarFeedsEnabled(settings: unknown): boolean {
  const s = (settings ?? {}) as { calendarFeeds?: { enabled?: unknown } };
  return s.calendarFeeds?.enabled === true;
}

/** Why the org's rules stop a calendar link being served, today. */
export type FeedInactiveReason = "switch_off" | "sso";

/** The org's rules a link is judged against (loadFeedStanding reads them). */
export interface FeedStanding {
  /** The org's switch (calendarFeedsEnabled). */
  enabled: boolean;
  /** The IdP connection the org requires sign-in through, or null when it requires none. */
  requiredIdpConnId: string | null;
}

/**
 * Why the org's rules stop this link, or null when they don't. The one rule
 * the feed (renderFeed), the list and creation all apply, so the list says a
 * link works exactly when it is served, and no link is made that would then
 * be refused. A link is a bearer credential like an API key, so single sign-on
 * holds it to the rule a member's key is (madeThroughRequiredIdp): where the
 * org requires single sign-on, only a link made through that org's IdP.
 *
 * The org's IP allowlist can't apply to a link: the calendar provider fetches
 * it from its own servers, never from the person's network.
 */
export function feedInactiveReason(standing: FeedStanding, link: { idpConnId: string | null }): FeedInactiveReason | null {
  if (!standing.enabled) return "switch_off";
  if (!madeThroughRequiredIdp(standing.requiredIdpConnId, link.idpConnId)) return "sso";
  return null;
}

/** What the calendar link list says under a link that has stopped, in the API key list's words. */
export const FEED_INACTIVE_TEXT: Record<FeedInactiveReason, string> = {
  switch_off: "Not active: an admin has turned off calendar feeds",
  sso: "Not active: it wasn't made through this organization's single sign-on. Sign in through it and make a new link to replace this one.",
};

/** Why a link can't be made right now, from the side of the person making it. */
export const FEED_CREATE_REFUSAL_TEXT: Record<FeedInactiveReason, string> = {
  switch_off: "Calendar feeds are turned off for this organization.",
  sso: "This organization requires single sign-on. Sign in through it to create a calendar link.",
};

/** Stored options, defaulted field by field so an old row never breaks a feed. */
export function readFeedOptions(json: unknown): FeedOptions {
  const o = (json ?? {}) as Partial<Record<keyof FeedOptions, unknown>>;
  const pick = (k: keyof FeedOptions) => (typeof o[k] === "boolean" ? (o[k] as boolean) : DEFAULT_FEED_OPTIONS[k]);
  return { workItems: pick("workItems"), meetings: pick("meetings"), intervals: pick("intervals"), busyOnly: pick("busyOnly") };
}
