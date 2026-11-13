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

/**
 * The domain portion of an email address (lowercased), or "" if malformed.
 *
 * Splits on the LAST "@", which is the one that decides where mail goes. The
 * earlier `split("@")[1]` took the SECOND segment, so `a@allowed.com@evil.com`
 * read as `allowed.com` while delivery would go to `evil.com` — the allowlist
 * would have passed an address it meant to refuse. Nothing could exploit it,
 * because every caller validates with `z.string().email()` first and that
 * rejects a second "@" (verified), but the allowlist's correctness should not
 * rest on a validator in another file. An address with no local part, such as
 * "@evil.com", is malformed and gets "".
 */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "";
  return email.slice(at + 1).toLowerCase().trim();
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

/**
 * True only when the org has LISTED `email`'s domain. Unlike
 * `emailDomainAllowed`, an empty list allows nothing: it is the test for
 * whether an org's own identity provider may vouch for an address, and an org
 * that has named no domains has not claimed any address.
 */
export function emailDomainListed(
  email: string,
  allowedDomains: string[] | null | undefined,
): boolean {
  const list = (allowedDomains ?? []).map(normalizeDomain).filter(Boolean);
  if (list.length === 0) return false;
  const domain = emailDomain(email);
  return !!domain && list.includes(domain);
}
