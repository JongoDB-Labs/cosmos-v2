/**
 * Build a `Content-Disposition` header value for a filename the user chose.
 *
 * THE BUG THIS EXISTS FOR. A macOS screenshot is named
 * `Screenshot 2026-10-29 at 10.28.00 AM.png` — and the space before "AM" is
 * U+202F NARROW NO-BREAK SPACE, not an ordinary space. HTTP header values are
 * Latin-1, so a raw U+202F is not representable: the AWS SDK threw
 * `TypeError: Invalid character in header content ["content-disposition"]`
 * while building the PutObject request, which surfaced as a 500 on every
 * screenshot upload. Reported twice (2026-08-07, 2026-10-29); the first was
 * closed as a duplicate and the cause was never found, because the failing
 * character is invisible in the filename.
 *
 * The two tempting half-fixes are both wrong:
 *
 *   - `encodeURIComponent(name)` inside the quoted form keeps the header legal
 *     but renames the file: the browser saves `Screenshot%202026-10-29...`,
 *     percent-escapes and all. Both attachment download routes did this.
 *   - stripping non-ASCII and nothing else loses the real name for every
 *     client, including the ones that can display it.
 *
 * So do what RFC 6266 §4.3 says and send BOTH forms. A client that understands
 * `filename*` (RFC 5987) uses the real UTF-8 name; anything older falls back to
 * the ASCII approximation. The quoted form must stay printable-ASCII only, and
 * `filename*` must be percent-encoded, or the header is illegal again.
 */

/** Characters legal unescaped in the quoted `filename=` form: printable ASCII
 *  minus `"` and `\`, which would end or escape the quoted string. */
const UNSAFE_IN_QUOTED = /[^\x20-\x21\x23-\x5B\x5D-\x7E]/g;

/**
 * RFC 5987 `attr-char` is stricter than `encodeURIComponent` leaves: these are
 * legal in a URI component but not in a header's extended parameter, so they
 * must be percent-encoded by hand.
 */
const UNSAFE_IN_EXT = /['()*!]/g;

const pct = (c: string) =>
  "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");

/**
 * @param filename the user's filename, any Unicode
 * @param disposition `inline` to render in the browser, `attachment` to download
 */
export function contentDisposition(
  filename: string,
  disposition: "inline" | "attachment" = "inline",
): string {
  // An empty or all-unprintable name still has to produce a legal header.
  const ascii = filename.replace(UNSAFE_IN_QUOTED, "_") || "file";
  const ext = encodeURIComponent(filename).replace(UNSAFE_IN_EXT, pct);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${ext}`;
}
