/**
 * Org slugs become the first URL path segment (`/<orgSlug>/...`), so they must
 * not collide with real top-level routes. Next.js matches static segments
 * before the dynamic `[orgSlug]`, so an org whose slug shadows one of these
 * would have an unreachable dashboard. Guard both creation and rename.
 */
const RESERVED_SLUGS = new Set([
  "api",
  "login",
  "logout",
  "onboarding",
  "internal",
  "settings",
  "admin",
  "static",
  "assets",
  "public",
  "_next",
  "favicon.ico",
  "apple-icon.png",
  "icon.png",
  "robots.txt",
  "sitemap.xml",
  "well-known",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}
