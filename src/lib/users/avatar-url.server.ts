import { createHash } from "node:crypto";

/** Characters of the `?v=` token: enough to tell two avatars apart, short enough to ignore. */
export const AVATAR_VERSION_LENGTH = 12;

/**
 * The `src` a browser should use for a user's avatar.
 *
 * Avatars are stored as `data:` URIs on `User.avatarUrl`. Returning those
 * inline makes every payload that names a user carry the image bytes: three
 * such avatars were 93% of a 171KB members response, and base64 does not
 * compress, so the proxy's `encode` cannot claw it back. This substitutes a
 * path to the avatar endpoint, which serves the same bytes once and
 * immutably, letting the browser cache them across every payload that
 * mentions that user.
 *
 * The stored column is deliberately NOT changed. `avatarUrlSchema`
 * (`src/lib/security/image-url.ts`) accepts only `data:image/*` or an
 * absolute http(s) URL, and the profile form echoes `avatarUrl` back on every
 * save without a dirty-check — so storing a relative path would make an
 * unrelated display-name edit fail validation. Substituting at the response
 * boundary keeps both of those inert.
 *
 * Only an avatar the endpoint can serve (see `decodeAvatarDataUri`) is
 * swapped. Anything else — an svg, a non-base64 `data:` URI — is returned
 * unchanged, because the endpoint would 404 it into a broken image.
 *
 * Checking that decodes the whole avatar, so a caller with many rows per user
 * should call this once per user, not once per row (see `avatarSrcs`).
 *
 * Server-only: `node:crypto` would break `next build` if this were pulled
 * into a client component. Clients never need it — they receive the result.
 */
export function avatarSrc(orgId: string, userId: string, stored: string | null | undefined): string | null {
  if (!stored) return null;
  // Already a URL the browser can cache on its own.
  if (!stored.startsWith("data:")) return stored;
  // Only swap what the endpoint can serve. It answers 404 for anything
  // `decodeAvatarDataUri` refuses (svg, non-base64), so pointing at it would
  // turn an avatar that shows today into a broken image. Keep those inline.
  if (!avatarServable(stored)) return stored;
  return avatarEndpointPath(orgId, userId, stored);
}

/**
 * The endpoint path for a stored avatar the caller has ALREADY checked with
 * `avatarServable`. Split out so a batch caller decodes each avatar once.
 */
export function avatarEndpointPath(orgId: string, userId: string, stored: string): string {
  // Versioned by CONTENT, so the URL is safe to serve `immutable` and two
  // users sharing the same bytes still get their own path.
  const version = createHash("sha256").update(stored).digest("hex").slice(0, AVATAR_VERSION_LENGTH);
  return `/api/v1/orgs/${orgId}/users/${userId}/avatar?v=${version}`;
}

/**
 * The raster types a browser renders for an avatar.
 *
 * SVG is deliberately absent. An SVG can embed script, and this endpoint
 * serves bytes from our own origin, so an `image/svg+xml` avatar would be
 * stored XSS. The column's write validator only admits `data:image/*`, which
 * `image/svg+xml` satisfies — so this allowlist, not that validator, is what
 * stops it.
 */
const AVATAR_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Decode a stored `data:` avatar into bytes plus a content type that is safe
 * to echo into a response header. Returns null for anything unrecognised,
 * non-base64, or not an allowlisted image — the caller answers 404, because a
 * caller cannot tell a missing avatar from an unusable one and does not need to.
 */
export function decodeAvatarDataUri(
  stored: string,
): { contentType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const parsed = /^data:([a-z0-9.+/-]+);base64,(.*)$/i.exec(stored);
  if (!parsed) return null;
  const contentType = parsed[1].toLowerCase();
  if (!AVATAR_CONTENT_TYPES.has(contentType)) return null;
  if (!parsed[2]) return null;
  const decoded = Buffer.from(parsed[2], "base64");
  if (decoded.byteLength === 0) return null;
  // A Uint8Array over its OWN ArrayBuffer. `Buffer` allocates from a shared
  // pool, so passing it to a Response risks serving whatever sits beside it,
  // and its `ArrayBufferLike` type is not assignable to BodyInit.
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return { contentType, bytes };
}

/** True when the avatar endpoint would serve this stored value (not 404 it). */
export function avatarServable(stored: string | null | undefined): stored is string {
  return !!stored && stored.startsWith("data:") && decodeAvatarDataUri(stored) !== null;
}
