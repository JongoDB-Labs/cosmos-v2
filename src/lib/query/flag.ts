/**
 * CQL ships behind a per-org switch until the whole feature (editor, saved
 * filters, history, boards, subscriptions) is in, then the switch is deleted.
 * Stored on Organization.settings.cql.enabled, like calendarFeeds.enabled.
 */
export function cqlEnabled(settings: unknown): boolean {
  const s = (settings ?? {}) as { cql?: { enabled?: unknown } };
  return s.cql?.enabled === true;
}

export function withCqlEnabled(settings: unknown, enabled: boolean): Record<string, unknown> {
  const s = { ...((settings ?? {}) as Record<string, unknown>) };
  s.cql = { ...((s.cql as Record<string, unknown>) ?? {}), enabled };
  return s;
}

/**
 * May filter emails carry item titles (query design §6.6)? An org admin's
 * choice; unset, it's off for GOV and on for COMMERCIAL.
 */
export function cqlEmailTitles(settings: unknown, tenantClass: string): boolean {
  const v = ((settings ?? {}) as { cql?: { emailTitles?: unknown } }).cql?.emailTitles;
  return typeof v === "boolean" ? v : tenantClass === "COMMERCIAL";
}

export function withCqlEmailTitles(settings: unknown, emailTitles: boolean): Record<string, unknown> {
  const s = { ...((settings ?? {}) as Record<string, unknown>) };
  s.cql = { ...((s.cql as Record<string, unknown>) ?? {}), emailTitles };
  return s;
}
