/**
 * How to serve a stored file back to a browser.
 *
 * `contentType` on a Document is whatever the UPLOADER said it was. Serving that
 * verbatim with `Content-Disposition: inline` is stored XSS: upload an .html
 * claiming text/html, send someone the link, and it runs on this origin with
 * their session. The upload gate used to prevent this by accident, refusing every
 * format it had no parser for — so widening what may be STORED means this has to
 * decide what may be RENDERED, separately.
 *
 * Four tiers:
 *   inline, as itself  images, pdf, audio and video — the browser renders or plays
 *                      these and they cannot script. SVG is NOT here: it is a
 *                      document that can carry <script>.
 *   inline, as text    .txt .md .csv .json .yml .sql, source files and the rest of
 *                      the long tail, forced to text/plain so a mislabelled payload
 *                      renders as characters and not as markup. A .js served as
 *                      text/plain cannot be loaded as a script either, because of
 *                      nosniff below.
 *   sandboxed          html, svg, xml. Served with `Content-Security-Policy:
 *                      sandbox`, which puts the response in an opaque origin with
 *                      scripting disabled — it cannot reach cookies, storage or the
 *                      parent page even when embedded. So a drawing or a saved page
 *                      can be LOOKED AT without being trusted.
 *   attachment         everything else. Downloaded as a byte stream, never rendered.
 *
 * `X-Content-Type-Options: nosniff` on all of them, so a browser cannot decide a
 * .txt is really HTML and promote it.
 *
 * The tier is chosen from the declared type where that is recognised, and from the
 * FILENAME where it is not. Browsers send no type at all for a great many ordinary
 * files — .log, .yml, .py, .sql — and deciding on the declared type alone would send
 * every one of them to the download tier, which is the wrong answer for a library
 * people are meant to read out of. Falling back to the extension can only ever
 * select one of the four tiers above, so it cannot widen the policy; executables
 * are refused at upload and appear in no map here.
 */
const INLINE_AS_IS = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
  "image/x-icon", "image/apng",
  "application/pdf",
  "video/mp4", "video/webm", "video/ogg", "video/quicktime",
  "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm", "audio/flac",
  "audio/aac", "audio/x-m4a",
]);

const TEXTUAL = new Set([
  "text/plain", "text/markdown", "text/csv", "text/tab-separated-values",
  "application/json", "application/x-ndjson", "text/x-log",
]);

/** Types a browser will execute, so they only ever go out sandboxed. */
const SANDBOXED = new Set([
  "text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml",
]);

/**
 * Filename extension -> the type to serve it as, used only when the declared type
 * is absent or unrecognised. Every value here is a member of one of the three sets
 * above; an extension that is not listed falls through to the download tier.
 */
const BY_EXTENSION: Record<string, string> = {
  // pictures
  png: "image/png", apng: "image/apng", jpg: "image/jpeg", jpeg: "image/jpeg",
  jfif: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  bmp: "image/bmp", ico: "image/x-icon",
  // documents a browser renders natively
  pdf: "application/pdf",
  // moving pictures and sound
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg",
  mov: "video/quicktime",
  mp3: "audio/mpeg", m4a: "audio/x-m4a", wav: "audio/wav", oga: "audio/ogg",
  ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac",
  // things that are words, whatever their extension claims
  txt: "text/plain", text: "text/plain", log: "text/x-log",
  md: "text/markdown", markdown: "text/markdown", rst: "text/plain",
  csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", ndjson: "application/x-ndjson", jsonl: "application/x-ndjson",
  yml: "text/plain", yaml: "text/plain", toml: "text/plain", ini: "text/plain",
  cfg: "text/plain", conf: "text/plain", properties: "text/plain",
  sql: "text/plain", diff: "text/plain", patch: "text/plain",
  ts: "text/plain", tsx: "text/plain", js: "text/plain", jsx: "text/plain",
  mjs: "text/plain", cjs: "text/plain", css: "text/plain", scss: "text/plain",
  py: "text/plain", rb: "text/plain", go: "text/plain", rs: "text/plain",
  java: "text/plain", kt: "text/plain", c: "text/plain", h: "text/plain",
  cpp: "text/plain", hpp: "text/plain", cs: "text/plain", php: "text/plain",
  pl: "text/plain", lua: "text/plain", swift: "text/plain", r: "text/plain",
  tf: "text/plain", graphql: "text/plain", proto: "text/plain", tex: "text/plain",
  // documents that can script, so they are only ever looked at behind a sandbox
  html: "text/html", htm: "text/html", xhtml: "application/xhtml+xml",
  svg: "image/svg+xml", xml: "text/xml", xsl: "text/xml", rss: "text/xml",
  atom: "text/xml",
};

type Tier = "as-is" | "text" | "sandbox" | "download";

function extensionOf(filename: string): string {
  const base = filename.toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/** The tier, and the concrete type to send with it. */
function classify(contentType: string | null, filename: string): { tier: Tier; type: string } {
  const declared = (contentType || "").split(";")[0].trim().toLowerCase();

  const tierOf = (ct: string): Tier | null =>
    INLINE_AS_IS.has(ct) ? "as-is"
      : SANDBOXED.has(ct) ? "sandbox"
        : TEXTUAL.has(ct) ? "text"
          : null;

  const direct = tierOf(declared);
  if (direct) return { tier: direct, type: declared };

  // An unlisted text/* subtype — text/x-python, text/yaml — is words. It is safe
  // to render because the type is rewritten to text/plain on the way out.
  // Checked AFTER the sets, so text/html and text/xml stay sandboxed.
  if (declared.startsWith("text/")) return { tier: "text", type: declared };

  const guessed = BY_EXTENSION[extensionOf(filename)];
  if (guessed) {
    const t = tierOf(guessed);
    if (t) return { tier: t, type: guessed };
  }
  return { tier: "download", type: "application/octet-stream" };
}

export function serveHeaders(contentType: string | null, filename: string): Headers {
  const { tier, type } = classify(contentType, filename);
  const safeName = filename.replace(/[\r\n"]/g, "");
  const h = new Headers({
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=300",
  });

  if (tier === "as-is") {
    h.set("Content-Type", type);
    h.set("Content-Disposition", `inline; filename="${safeName}"`);
  } else if (tier === "text") {
    // charset pinned: a file claiming text/plain in UTF-7 could otherwise smuggle
    // markup past a browser that honours the declaration.
    h.set("Content-Type", "text/plain; charset=utf-8");
    h.set("Content-Disposition", `inline; filename="${safeName}"`);
  } else if (tier === "sandbox") {
    h.set("Content-Type", type);
    h.set("Content-Disposition", `inline; filename="${safeName}"`);
    h.set("Content-Security-Policy", "sandbox");
  } else {
    h.set("Content-Type", "application/octet-stream");
    h.set("Content-Disposition", `attachment; filename="${safeName}"`);
  }
  return h;
}

export type RenderMode = "image" | "pdf" | "video" | "audio" | "text" | "sandboxed" | "download";

/** What the viewer should do with it, for the client. Agrees with serveHeaders. */
export function renderModeFor(contentType: string | null, filename = ""): RenderMode {
  const { tier, type } = classify(contentType, filename);
  if (tier === "as-is") {
    if (type === "application/pdf") return "pdf";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    return "image";
  }
  if (tier === "text") return "text";
  if (tier === "sandbox") return "sandboxed";
  return "download";
}
