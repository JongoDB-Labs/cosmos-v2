/**
 * How to serve a stored file back to a browser.
 *
 * `contentType` on a Document is whatever the UPLOADER said it was. Serving that
 * verbatim with `Content-Disposition: inline` is stored XSS: upload an .html
 * claiming text/html, send someone the link, and it runs on this origin with
 * their session. Until now the only thing standing in the way was an upload
 * gate that refused every format without a parser — so widening what may be
 * stored means this has to decide what may be RENDERED, separately.
 *
 * Three tiers:
 *   inline, as itself  images, pdf — the browser renders these and they cannot
 *                      script. SVG is NOT here: it is a document that can carry
 *                      <script>.
 *   inline, as text    .txt .md .csv .json and friends, forced to text/plain so
 *                      a mislabelled payload renders as characters, not markup.
 *   sandboxed          html, svg, xml. Served with `Content-Security-Policy:
 *                      sandbox`, which puts the response in an opaque origin
 *                      with scripting disabled — it cannot reach cookies, storage
 *                      or the parent page even when embedded.
 *   attachment         everything else. Downloaded, never rendered.
 *
 * `X-Content-Type-Options: nosniff` on all of them, so a browser cannot decide a
 * .txt is really HTML and promote it.
 */
const INLINE_AS_IS = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
  "application/pdf",
]);

const TEXTUAL = new Set([
  "text/plain", "text/markdown", "text/csv", "text/tab-separated-values",
  "application/json", "application/x-ndjson", "text/x-log",
]);

/** Types a browser will execute, so they only ever go out sandboxed. */
const SANDBOXED = new Set([
  "text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml",
]);

export function serveHeaders(contentType: string | null, filename: string): Headers {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  const safeName = filename.replace(/[\r\n"]/g, "");
  const h = new Headers({
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=300",
  });

  if (INLINE_AS_IS.has(ct)) {
    h.set("Content-Type", ct);
    h.set("Content-Disposition", `inline; filename="${safeName}"`);
  } else if (TEXTUAL.has(ct)) {
    // charset pinned: a file claiming text/plain in UTF-7 could otherwise smuggle
    // markup past a browser that honours the declaration.
    h.set("Content-Type", "text/plain; charset=utf-8");
    h.set("Content-Disposition", `inline; filename="${safeName}"`);
  } else if (SANDBOXED.has(ct)) {
    h.set("Content-Type", ct);
    h.set("Content-Disposition", `inline; filename="${safeName}"`);
    h.set("Content-Security-Policy", "sandbox");
  } else {
    h.set("Content-Type", "application/octet-stream");
    h.set("Content-Disposition", `attachment; filename="${safeName}"`);
  }
  return h;
}

/** What the viewer should do with it, for the client. */
export function renderModeFor(contentType: string | null): "image" | "pdf" | "text" | "sandboxed" | "download" {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (INLINE_AS_IS.has(ct)) return ct === "application/pdf" ? "pdf" : "image";
  if (TEXTUAL.has(ct)) return "text";
  if (SANDBOXED.has(ct)) return "sandboxed";
  return "download";
}
