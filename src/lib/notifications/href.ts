/**
 * Where a notification's link points, inside the org the viewer is in.
 *
 * Notification writers are not consistent about `url`: some store an
 * org-relative path ("/notes/x"), others an already-prefixed one
 * ("/{slug}/issues?item=…"). Every reader must prefix the slug exactly once.
 * The Inbox page didn't, and on 2.465.0 every one of its links pointed at
 * "/{slug}/{slug}/…" and landed on a 404. The bell had its own copy of the
 * rule; both now use this.
 *
 * A URL with a scheme ("https://…") is someone else's page and passes through.
 * With no org in view the path is returned as is, never as "//path", which a
 * browser would read as a link to another host.
 */
export function notificationHref(orgSlug: string | null, url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  let path = url.startsWith("/") ? url : `/${url}`;
  if (!orgSlug) return path;
  const prefix = `/${orgSlug}`;
  if (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)) {
    path = path.slice(prefix.length) || "/";
  }
  return path === "/" ? prefix : `${prefix}${path}`;
}
