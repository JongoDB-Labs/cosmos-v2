import { z } from "zod";

/**
 * Builds a zod validator for an image URL accepted on write — an org logo or a
 * user avatar.
 *
 * `z.string().url()` only checks URL *shape*, so it waves through `javascript:`
 * and `data:text/html`. These values get stored and later echoed back to
 * clients (the org logo is even served by a public, unauthenticated brand
 * endpoint), so we allow-list schemes here as defense-in-depth: an inline
 * `data:image/...` URL (capped at `maxBytes` to bound the stored row) or an
 * http(s) URL. Everything else is rejected.
 *
 * Sibling of {@link ./webhook-url} `webhookUrlSchema`, which guards a different
 * class of stored URL (SSRF) with the same allow-list approach.
 */
export function imageUrlSchema(
  maxBytes: number,
  message = "Must be an http(s) URL or a data:image URL within the size limit",
) {
  return z
    .string()
    .refine((v) => {
      if (v.startsWith("data:image/")) return v.length <= maxBytes;
      try {
        const u = new URL(v);
        return u.protocol === "https:" || u.protocol === "http:";
      } catch {
        return false;
      }
    }, message)
    .nullable()
    .optional();
}

// Org logo: inline image up to ~200KB (≈280KB base64) or an http(s) URL.
// Shared by the general org-update route and the theme route so the two stay
// consistent.
export const logoUrlSchema = imageUrlSchema(
  280_000,
  "Must be a data URL ≤200KB or an https URL",
);
