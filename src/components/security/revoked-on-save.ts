/**
 * What the security settings page says after a save that revoked credentials:
 * turning on Require MFA deletes the API keys of people who can't manage keys
 * and revokes every calendar link in the org. Null when nothing went, since a
 * save that revoked nothing needs no more than the usual confirmation.
 */
export function revokedOnSaveText(saved: { apiKeysRevoked?: number; calendarFeedsRevoked?: number } | undefined): string | null {
  const keys = saved?.apiKeysRevoked ?? 0;
  const links = saved?.calendarFeedsRevoked ?? 0;
  const parts = [
    keys > 0 ? `${keys} API ${keys === 1 ? "key" : "keys"}` : null,
    links > 0 ? `${links} calendar ${links === 1 ? "link" : "links"}` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return `Saved. ${parts.join(" and ")} ${keys + links === 1 ? "was" : "were"} revoked.`;
}
