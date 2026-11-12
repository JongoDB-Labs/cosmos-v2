import { chatDrawerHref, legacyChatPath } from "./drawer-link";

/**
 * Where a visit to the old full-page chat goes now.
 *
 * Chat lives in the docked drawer, so `/<org>/chat` and `/<org>/chat/<id>` no
 * longer render. Bookmarks, emailed links and notifications sent before the
 * drawer still point there, so the proxy answers them with a 307 to the page
 * the person came from, with the drawer open on the same conversation:
 *
 *   /acme/chat/<id>   from /acme/projects?view=list
 *     -> /acme/projects?view=list&chat=<id>
 *
 * "Came from" is the Referer, and it is trusted only when it is this site and
 * this org: a link opened from a mail client, another org or the sign-in page
 * lands on the org home instead. Only the Referer's path and query are used,
 * never its host, so it cannot send anyone to another site.
 *
 * The fragment never reaches the server. On a full page load the browser keeps
 * it across the redirect, so an old `#msg-<id>` still arrives, and
 * `chatDrawerTargetFromParams` reads it.
 */
export function legacyChatRedirect(input: {
  method: string;
  pathname: string;
  /** The request's Referer header. */
  referer: string | null;
  /** The host the visitor used: X-Forwarded-Host, else Host. */
  host: string | null;
}): string | null {
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  const legacy = legacyChatPath(input.pathname);
  if (!legacy) return null;
  const base = previousPage(input.referer, input.host, legacy.orgSlug) ?? `/${legacy.orgSlug}`;
  return chatDrawerHref(base, legacy.channelId ? { channelId: legacy.channelId } : {});
}

/** The Referer's path and query, when it is a page of this org on this site. */
function previousPage(referer: string | null, host: string | null, orgSlug: string): string | null {
  if (!referer || !host) return null;
  let u: URL;
  try {
    u = new URL(referer);
  } catch {
    return null;
  }
  // Same rule as the proxy's CSRF check: a forwarded host without a port
  // matches a Referer that carries one.
  const sameSite = u.host === host || (!host.includes(":") && u.hostname === host);
  if (!sameSite) return null;
  const inOrg = u.pathname === `/${orgSlug}` || u.pathname.startsWith(`/${orgSlug}/`);
  if (!inOrg) return null;
  // Never back to the old chat page itself; that would only redirect again.
  if (legacyChatPath(u.pathname)) return null;
  return u.pathname + u.search;
}
