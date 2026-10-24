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
