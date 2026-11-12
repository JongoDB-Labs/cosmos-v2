import { getStorage } from "@/lib/storage";
import { storedOrgLogo } from "@/lib/org/stored-logo";
import { resolvePdfLogo } from "./brand";

/**
 * An org's logo as bytes a document can draw, from wherever it actually lives.
 *
 * There are two storage shapes in the wild and a PDF has to cope with both:
 *
 *  1. An inline `data:image/...` URL on `Organization.logoUrl` — the original
 *     shape, decoded by {@link resolvePdfLogo} with no IO.
 *  2. An uploaded file in the deployment's own object storage, recorded as
 *     `settings.logoStorageKey` + `settings.logoContentType`, with `logoUrl`
 *     pointing at the streaming route that serves it.
 *
 * Shape 2 is what the upload UI produces, and `logoUrl` is then a RELATIVE app
 * path — so the data-URL decoder rejects it and, before this, every generated
 * document silently dropped the logo while the app showed it correctly.
 *
 * **Why reading storage here is not the SSRF case.** `resolvePdfLogo`
 * deliberately refuses to fetch an http(s) `logoUrl`, because that value is an
 * org-admin text field and fetching it server-side would turn an export path
 * into a request primitive aimed at anything the instance can reach. A storage
 * key is not that: it is inside the deployment boundary, and the app itself
 * wrote it during an authenticated upload. It is read through
 * `storedOrgLogo`, which only accepts a key in the org's own `branding/`
 * folder, so a key that names anything else is skipped.
 */

/**
 * What pdfkit can actually embed. The upload route also accepts `image/webp`,
 * and SVG logos uploaded before SVG was refused may still be stored; both render
 * in the browser and cannot go into a document at all — pdfkit reads PNG and
 * JPEG only. Such a logo is skipped,
 * so the export succeeds without a mark rather than failing.
 */
const PDF_EMBEDDABLE = new Set(["image/png", "image/jpeg"]);

/**
 * Ceiling on bytes pulled into memory for one document. Mirrors the 2MB limit
 * the upload route enforces, so a logo that was legitimately accepted is not
 * then silently dropped by a tighter cap here — that mismatch is precisely the
 * class of bug this module exists to remove. If that route's limit changes,
 * change this with it.
 */
const MAX_STORED_LOGO_BYTES = 2 * 1024 * 1024;

/** The fields of an org row this needs — a subset any caller already has. */
export type OrgLogoSource = {
  /** The org's id: an uploaded logo is only read from this org's own folder. */
  id: string;
  logoUrl?: string | null;
  settings?: unknown;
};

/** Drain a web stream into one Buffer, abandoning it past `limit` bytes. */
async function collect(stream: ReadableStream, limit: number): Promise<Buffer | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      // Stop reading rather than buffering the rest of an oversized object.
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return total === 0 ? null : Buffer.concat(chunks);
}

/**
 * Resolve the logo for a document, inline first and object storage second.
 *
 * Never throws and never fails an export: a missing object, an unreadable
 * stream, an un-embeddable format or an oversized file all resolve to `null`
 * and the document simply renders without a mark. The document is the thing
 * that matters; the logo is decoration.
 */
export async function loadPdfLogo(org?: OrgLogoSource | null): Promise<Buffer | null> {
  if (!org) return null;

  const inline = resolvePdfLogo(org.logoUrl);
  if (inline) return inline;

  const stored = storedOrgLogo(org.id, org.settings);
  if (!stored || !PDF_EMBEDDABLE.has(stored.contentType)) return null;

  try {
    const stream = await getStorage().stream(stored.key);
    if (!stream) return null;
    return await collect(stream, MAX_STORED_LOGO_BYTES);
  } catch {
    return null;
  }
}
