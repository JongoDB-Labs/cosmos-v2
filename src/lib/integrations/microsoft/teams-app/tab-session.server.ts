import { openSecret, sealSecret } from "@/lib/crypto/vault";
import { teamsOrgsForTenant, teamsUsers, type TeamsUser } from "./identity.server";
import { TAB_PATH, isTabPath } from "./tab-paths";

export { TAB_PATH, isTabPath };

/**
 * COSMOS-202 T1 d: the Teams tab's own short session.
 *
 * Teams shows the tab in a third-party iframe, where the main `session`
 * cookie (SameSite=Lax) is never sent, and must not be relaxed. So the tab
 * signs in on its own: a Teams SSO token, verified once, becomes this sealed
 * cookie. It is
 *  - bound to org, user, tenant and Microsoft object id;
 *  - an hour at most and never extended (the tab silently signs in again);
 *  - HttpOnly; Secure; SameSite=None; Partitioned (CHIPS); Path=/teams/tab;
 *  - accepted ONLY for a GET under /teams/tab, enforced here and not left to
 *    the cookie's Path: nothing under /api, and nothing that writes, ever
 *    reads it;
 *  - re-checked on every read: the Teams app still on, the person still a
 *    member, not deactivated, and still the one who connected that Microsoft
 *    account in that tenant.
 */

export const TAB_COOKIE = "teams_tab";
export const TAB_TTL_S = 3600;
const PURPOSE = "teams_tab";

interface Payload {
  p: typeof PURPOSE;
  o: string;
  u: string;
  tid: string;
  oid: string;
  exp: number;
}


export function sealTabSession(s: { orgId: string; userId: string; tid: string; oid: string }, now = Date.now()): string {
  const payload: Payload = { p: PURPOSE, o: s.orgId, u: s.userId, tid: s.tid, oid: s.oid, exp: Math.floor(now / 1000) + TAB_TTL_S };
  return sealSecret(JSON.stringify(payload));
}

/** The Set-Cookie value for a sealed session (or, with "", one that clears it). */
export function tabCookieHeader(sealed: string): string {
  const maxAge = sealed ? TAB_TTL_S : 0;
  return `${TAB_COOKIE}=${sealed}; Path=${TAB_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None; Partitioned`;
}

function open(sealed: string, now: number): Payload | null {
  try {
    const p = JSON.parse(openSecret(sealed)) as Partial<Payload>;
    if (p.p !== PURPOSE || !p.o || !p.u || !p.tid || !p.oid || typeof p.exp !== "number") return null;
    const nowS = Math.floor(now / 1000);
    // Expired, or claiming more life than any session we issue.
    if (p.exp <= nowS || p.exp - nowS > TAB_TTL_S) return null;
    return p as Payload;
  } catch {
    return null;
  }
}

/**
 * The person a tab request is for, or null. `method` and `pathname` are the
 * request's own: anything but a GET under /teams/tab is refused before the
 * cookie is even opened.
 */
export async function readTabSession(
  req: { method: string; pathname: string; cookie: string | undefined },
  now = Date.now(),
): Promise<TeamsUser | null> {
  if (req.method !== "GET" || !isTabPath(req.pathname) || !req.cookie) return null;
  const s = open(req.cookie, now);
  if (!s) return null;
  const orgs = (await teamsOrgsForTenant(s.tid)).filter((o) => o.orgId === s.o);
  const users = await teamsUsers(orgs, s.tid, s.oid);
  return users.find((x) => x.userId === s.u) ?? null;
}
