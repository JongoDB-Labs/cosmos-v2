/**
 * Masking for addresses that are about to be written somewhere an operator can
 * read but that matched no account here — i.e. arbitrary strings supplied by an
 * unauthenticated caller. Keeps a report correlatable (domain plus first
 * letter) without retaining a copy of someone else's address.
 *
 * Not a security boundary: addresses that DO belong to the org are logged in
 * full, because that is the case an operator is asked to explain and we already
 * hold the address. This is about not accumulating third-party PII.
 */
export function maskEmail(email: string): string {
  // Split on the LAST @ so a quoted local part cannot leak through.
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  return `${local[0]}***${email.slice(at)}`;
}

/** Upstream error text is not ours and not bounded; keep a log line a line. */
export function truncateForLog(s: string, max = 200): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
