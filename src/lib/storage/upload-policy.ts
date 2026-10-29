/**
 * What an attachment upload accepts, and how it must be served back.
 *
 * Feedback attachments began as screenshots: images plus PDF, every one of them
 * verifiable by magic bytes, so the stored `contentType` could be trusted and
 * served `inline` safely. FR 54b64bad asks for documents too — "docx, csv,
 * xlsx, txt, pdf, and other common file types … for foreman to use RAG and
 * understand context" — and that changes the security question, because
 * PLAIN TEXT HAS NO MAGIC BYTES. `fileTypeFromBuffer` returns undefined for
 * .txt/.csv/.md/.json, so for those the type can only come from the client,
 * which makes it caller-controlled.
 *
 * Caller-controlled type + `inline` + no `nosniff` is stored XSS on the app's
 * own origin: upload bytes that are really HTML, declare them text/plain, and a
 * sniffing browser may render them. So the policy here is two-tier:
 *
 *   VERIFIED  magic bytes confirm the type → may be served `inline`
 *   DECLARED  no magic bytes; the EXTENSION must agree with the declared type,
 *             the type is normalised to a safe one, and it is served
 *             `attachment` so a browser downloads rather than renders it
 *
 * Both tiers get `X-Content-Type-Options: nosniff` at the download route, which
 * neither attachment route set before.
 */

/** Types a magic-byte sniff can confirm. Safe to render in place. */
const VERIFIED: Record<string, "image" | "file"> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "file",
  // OOXML is a ZIP container and `file-type` identifies each specifically.
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "file",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "file",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "file",
  // Legacy Office, also sniffable (OLE compound file).
  "application/msword": "file",
  "application/vnd.ms-excel": "file",
};

/**
 * Extension → the type we will STORE it as, for formats with no signature.
 * The declared type is never stored as given; it is replaced by this, so a
 * client cannot choose what the download is served as.
 */
const DECLARED: Record<string, string> = {
  txt: "text/plain",
  md: "text/plain",
  csv: "text/csv",
  json: "application/json",
  log: "text/plain",
  tsv: "text/tab-separated-values",
};

export interface UploadDecision {
  ok: boolean;
  /** The type to STORE and later serve. Never the raw client value. */
  contentType?: string;
  kind?: "image" | "file";
  /** How the download route must offer it. */
  disposition?: "inline" | "attachment";
  reason?: string;
}

/**
 * @param sniffed  `fileTypeFromBuffer`'s verdict, or undefined when it has none
 * @param filename the client's filename, used ONLY for its extension
 */
export function decideUpload(
  sniffed: string | undefined,
  filename: string,
): UploadDecision {
  if (sniffed) {
    const kind = VERIFIED[sniffed];
    if (!kind) return { ok: false, reason: `unsupported_mime:${sniffed}` };
    return { ok: true, contentType: sniffed, kind, disposition: "inline" };
  }

  // No signature. The extension decides, and only from a closed list — so an
  // unknown binary cannot arrive by simply omitting a recognisable header.
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const declared = DECLARED[ext];
  if (!declared) return { ok: false, reason: `unsupported_extension:${ext || "none"}` };
  return { ok: true, contentType: declared, kind: "file", disposition: "attachment" };
}

/** Everything the upload route will accept, for the file picker's `accept`. */
export const ACCEPT_ATTRIBUTE = [
  ...Object.keys(VERIFIED),
  ...Object.keys(DECLARED).map((e) => `.${e}`),
].join(",");

/**
 * How a STORED attachment must be served, from its stored content type.
 *
 * Reads the same `VERIFIED` table the upload decision used, so the two can
 * never disagree: anything whose type was confirmed by magic bytes may render
 * in place, and everything else downloads. Rows stored before the declared
 * tier existed are all images or PDF, so they keep rendering inline exactly as
 * before.
 */
export function dispositionFor(contentType: string): "inline" | "attachment" {
  return contentType in VERIFIED ? "inline" : "attachment";
}
