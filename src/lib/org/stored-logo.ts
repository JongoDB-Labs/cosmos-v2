import { isSafeStorageKey } from "@/lib/storage/keys";

/**
 * An org's uploaded logo, read back from `settings.logoStorageKey` and
 * `settings.logoContentType`.
 *
 * Only the logo upload route writes those two settings, and it always writes a
 * key under `<orgId>/branding/`. Everything that reads them back (the route that
 * streams the logo, the delete of the previous one, the PDF exports) goes
 * through here, so a key outside that folder is never read or deleted, whatever
 * put it there: on the local adapter such a key once reached files outside
 * storage, and on S3 another org's objects.
 */

/** What the upload route accepts today. */
export const LOGO_UPLOAD_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * What a stored logo may be served as. SVG is no longer accepted at upload (it
 * is a document that can carry script), but logos uploaded before that still
 * display; the route serves every logo under a sandboxing CSP.
 */
const SERVABLE_TYPES = new Set([...LOGO_UPLOAD_TYPES, "image/svg+xml"]);

export type StoredLogo = { key: string; contentType: string };

export function storedOrgLogo(orgId: string, settings: unknown): StoredLogo | null {
  if (!orgId) return null;
  const s = (settings ?? {}) as Record<string, unknown>;
  const key = s.logoStorageKey;
  if (typeof key !== "string" || !key.startsWith(`${orgId}/branding/`) || !isSafeStorageKey(key)) {
    return null;
  }
  const declared = s.logoContentType;
  const contentType =
    typeof declared === "string" && SERVABLE_TYPES.has(declared) ? declared : "application/octet-stream";
  return { key, contentType };
}
