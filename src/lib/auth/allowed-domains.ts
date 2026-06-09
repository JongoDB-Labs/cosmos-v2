/**
 * Per-org email-domain allowlist (`OrgSecuritySettings.allowedDomains`).
 *
 * Semantics: an EMPTY list means "no restriction" (any email may be invited).
 * A non-empty list restricts who can be NEWLY invited to the org — existing
 * members are never affected, so an owner on a different domain can't lock
 * themselves out by setting a list.
 */

/** Normalize a configured domain entry: strip a leading "@", lowercase, trim. */
export function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^@+/, "");
}

/** The domain portion of an email address (lowercased), or "" if malformed. */
export function emailDomain(email: string): string {
  return email.toLowerCase().split("@")[1]?.trim() ?? "";
}

/**
 * True when `email` is allowed under `allowedDomains`. An empty/blank list is
 * unrestricted. Exact domain match only (no subdomain wildcarding) — keep the
 * mental model simple and predictable for admins.
 */
export function emailDomainAllowed(
  email: string,
  allowedDomains: string[] | null | undefined,
): boolean {
  const list = (allowedDomains ?? []).map(normalizeDomain).filter(Boolean);
  if (list.length === 0) return true;
  const domain = emailDomain(email);
  if (!domain) return false;
  return list.includes(domain);
}
