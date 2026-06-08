/**
 * Shared active-link logic for every nav surface (sidebar, topbar, mobile).
 *
 * The hard cases this guards against:
 *
 *  1. No current org (e.g. /onboarding, or an unknown slug). Previously the
 *     fallback href was "/", which is a prefix of every path, so EVERY item
 *     except the most-specific lit up. When there is no org we resolve every
 *     href to a sentinel that can never match the pathname, so nothing
 *     highlights.
 *  2. The org overview ("" href) must match EXACTLY — otherwise its "/{slug}"
 *     prefix lights it up on every sub-page.
 *  3. A parent route ("/finance") must not stay active when a more-specific
 *     sibling ("/finance/accounting") is the active page. Callers pass the
 *     sibling hrefs so we can suppress the shorter match.
 */

/** A path that can never equal a real pathname — used when there's no org. */
const NO_MATCH = "\0__no_org__";

/** Resolve an org-relative href to an absolute path, or NO_MATCH if no org. */
export function resolveHref(
  orgSlug: string | undefined,
  relativeHref: string,
): string {
  if (!orgSlug) return NO_MATCH;
  return `/${orgSlug}${relativeHref}`;
}

/**
 * The href to put in an actual <Link>. Unlike resolveHref (which returns the
 * NO_MATCH sentinel for active-state comparison when there's no org), this
 * always returns a navigable path — falling back to "/" when there's no org so
 * sidebar links never become dead links to the sentinel string.
 */
export function hrefFor(
  orgSlug: string | undefined,
  relativeHref: string,
): string {
  if (!orgSlug) return "/";
  return `/${orgSlug}${relativeHref}`;
}

/**
 * Is `pathname` active for the absolute `href`?
 *
 * @param pathname  current pathname
 * @param href      absolute href for this item (already org-resolved)
 * @param isRoot    true when this is the org-overview item (exact match only)
 * @param siblingHrefs  absolute hrefs of more-specific siblings; if any of them
 *                      matches, this (shorter) item is suppressed
 */
export function isHrefActive(
  pathname: string,
  href: string,
  isRoot: boolean,
  siblingHrefs: string[] = [],
): boolean {
  if (href === NO_MATCH) return false;
  if (isRoot) return pathname === href;
  if (pathname !== href && !pathname.startsWith(href + "/")) return false;
  // Suppress this item when a longer, more-specific sibling also matches.
  for (const other of siblingHrefs) {
    if (other === NO_MATCH || other === href) continue;
    if (!other.startsWith(href + "/")) continue;
    if (pathname === other || pathname.startsWith(other + "/")) return false;
  }
  return true;
}
