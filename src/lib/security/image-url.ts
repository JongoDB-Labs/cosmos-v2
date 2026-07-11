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

// --- User avatar limits ---------------------------------------------------
// Avatars are stored inline as a data-URL on the User row, so we bound both the
// source file we're willing to decode and the resulting stored string. Large
// photos are downscaled client-side to fit the stored cap, so a user can pick
// any reasonable image and it just works instead of being rejected for size.
// Keep these as the single source of truth: the profile form (client) and the
// `/api/v1/me` route (server) both import them so the limit stays in sync.

// Largest source file we'll attempt to decode/downscale. Files above this are
// rejected up-front rather than hanging on an absurd multi-hundred-MB pick.
export const MAX_AVATAR_SOURCE_BYTES = 25_000_000;
export const MAX_AVATAR_SOURCE_MB = Math.round(MAX_AVATAR_SOURCE_BYTES / 1_000_000);

// Safety ceiling on the stored data-URL string length (~1MB image as base64,
// which expands ~34%, plus the data-URL prefix). The client downscales large
// photos to fit, so this is just a backstop.
export const MAX_AVATAR_DATAURL_BYTES = 1_400_000;

// Avatar write validator: an inline data:image URL within the stored cap, or an
// http(s) URL. Mirrors `logoUrlSchema` but with the larger avatar ceiling.
export const avatarUrlSchema = imageUrlSchema(
  MAX_AVATAR_DATAURL_BYTES,
  "That avatar image is too large — pick a smaller photo (large images are resized automatically).",
);
