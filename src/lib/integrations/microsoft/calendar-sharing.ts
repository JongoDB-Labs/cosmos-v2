/**
 * COSMOS-202: how much of a Cosmos event is published into someone's Outlook,
 * the way a calendar app's own sharing levels work — "full" details, or "busy":
 * free/busy only, with no title, details or link, so a calendar they share with
 * colleagues (or the whole org) shows nothing but that the time is taken.
 *
 * An admin sets the org-wide default, on Organization.settings alongside the
 * subscription feeds' switch (lib/calendar/feed-settings.ts) rather than on the
 * integration, whose config is replaced whole whenever its tenant is re-saved.
 * Each person may choose their own, stored on their connection
 * (ConnectorCredential.meta), and everyone starts out following the org's
 * default. Pure, so both the sync and the API read the same rules.
 *
 * A RESTRICTED (classified) meeting is always busy-only whatever is chosen
 * here — the same rule the subscription feed's `busyOnly` already follows.
 */

export const SHARING_LEVELS = ["full", "busy"] as const;
export type SharingLevel = (typeof SHARING_LEVELS)[number];

/** What an org publishes until an admin chooses otherwise. */
export const DEFAULT_SHARING_LEVEL: SharingLevel = "full";

const asLevel = (v: unknown): SharingLevel | null =>
  SHARING_LEVELS.includes(v as SharingLevel) ? (v as SharingLevel) : null;

/** The org-wide default, from Organization.settings.outlookCalendar. */
export function orgSharingLevel(settings: unknown): SharingLevel {
  const s = (settings ?? {}) as { outlookCalendar?: { sharingLevel?: unknown } };
  return asLevel(s.outlookCalendar?.sharingLevel) ?? DEFAULT_SHARING_LEVEL;
}

/** Those settings with a new default, leaving every other setting alone. */
export function withOrgSharingLevel(settings: unknown, level: SharingLevel): Record<string, unknown> {
  const s = { ...((settings ?? {}) as Record<string, unknown>) };
  s.outlookCalendar = { ...((s.outlookCalendar as Record<string, unknown>) ?? {}), sharingLevel: level };
  return s;
}

/** One person's own choice, from their connection meta; null = follow the org. */
export function userSharingLevel(meta: unknown): SharingLevel | null {
  return asLevel((meta as { sharingLevel?: unknown } | null)?.sharingLevel);
}

/** What is actually published for someone: their own choice, else the org's. */
export function effectiveSharingLevel(orgDefault: SharingLevel, own: SharingLevel | null): SharingLevel {
  return own ?? orgDefault;
}
