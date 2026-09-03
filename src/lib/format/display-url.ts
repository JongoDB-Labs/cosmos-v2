/**
 * A readable label for a link whose href is a raw URL.
 *
 * BR: "links that are commented on tickets show the whole url after submitting
 * the comment." An 85-character URL rendered as its own link text was measured
 * at 437px wide in a comment thread — it wraps, it pushes the thread around, and
 * the part a reader actually needs (which host, which document) is buried in the
 * middle of it.
 *
 * The full URL is never lost: callers keep it as the `href` and the `title`.
 * This only decides what the reader SEES.
 */

/** Longest label we will render. Past this the middle is elided. */
const MAX_LINK_TEXT = 48;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * `https://example.com/a/b/spec.pdf?v=2` → `example.com/a/b/spec.pdf…`
 *
 * Rules, in order:
 *  - Drop the scheme and a leading `www.` — noise in every link.
 *  - Drop a bare trailing `/`.
 *  - Keep the host and the END of the path when it has to be shortened. The end
 *    is the identifying part (a document name); the middle is routing. Eliding
 *    the tail instead would render a page of links that all read
 *    `example.com/sites/teams/pro…`.
 *  - Append `…` when a query string or fragment was dropped, so the label never
 *    claims to be the whole URL.
 *  - Anything unparseable is returned truncated rather than thrown away — a
 *    malformed link should still be clickable text, not vanish.
 */
export function displayUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return truncate(raw, MAX_LINK_TEXT);
  }

  const host = u.host.replace(/^www\./i, "");
  const tail = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  const truncatedMarker = u.search || u.hash ? "…" : "";
  const base = host + tail;

  if (base.length <= MAX_LINK_TEXT) return base + truncatedMarker;

  // Budget: the host is never elided (it is the thing a reader checks first),
  // so what remains after the host and the "/…" joiner goes to the path tail.
  const budget = MAX_LINK_TEXT - host.length - 2;
  if (budget < 8) return truncate(host, MAX_LINK_TEXT);
  return `${host}/…${tail.slice(-budget)}`;
}

/**
 * Is this link text just the URL restated?
 *
 * Lexical's markdown export turns an auto-linked URL into `[url](url)`, so a
 * pasted link arrives with its own href as its label. Rendering that verbatim
 * shows the URL twice. Compared loosely — a trailing slash or a `www.` is not a
 * different label.
 */
export function isBareUrlLabel(label: string, href: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  return norm(label) === norm(href);
}
