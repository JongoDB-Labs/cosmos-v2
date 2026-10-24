import { NextRequest } from "next/server";
import { configuredPublicOrigin } from "@/lib/integrations/microsoft/hosts";
import { getRateLimitKey, rateLimit } from "@/lib/rate-limit/bucket";
import { EntraAuthError, tabAppIdUri, verifyTabToken } from "@/lib/integrations/microsoft/teams-app/entra-auth.server";
import { teamsAppTenants, teamsBotAppId, teamsOrgsForTenant, teamsUsers } from "@/lib/integrations/microsoft/teams-app/identity.server";
import { readCapped } from "@/lib/integrations/microsoft/teams-app/read-capped";
import { sealTabSession, tabCookieHeader } from "@/lib/integrations/microsoft/teams-app/tab-session.server";

/**
 * COSMOS-202 T1 d: a Teams tab signs in. Body: { token, org? }, where token is
 * the Teams SSO token (TeamsJS getAuthToken). Public (no Cosmos session), but
 * NOT CSRF-exempt: the tab posts same-origin from its own frame, so a page of
 * any other origin, another Teams app in the same partition included, can't
 * sign a victim's tab in to the attacker's account. Its only credential is that token,
 * verified in full before anything is decided. It SETS the tab session and
 * never reads one. Rate limited per IP before verification and per tenant
 * after; the token is never logged.
 */

const MAX_BODY = 16 * 1024;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

const claimedTenant = (token: string): string => {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { tid?: unknown };
    return typeof claims.tid === "string" ? claims.tid.toLowerCase() : "";
  } catch {
    return "";
  }
};

export async function POST(request: NextRequest) {
  const ip = rateLimit(getRateLimitKey(request, "teams-tab-session"), { capacity: 30, refillPerSecond: 0.5 });
  if (!ip.allowed) return json(429, { error: "rate_limited" }, { "Retry-After": String(ip.retryAfter) });

  const raw = await readCapped(request, MAX_BODY);
  if (raw === null) return new Response(null, { status: 413 });
  let body: { token?: unknown; org?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return new Response(null, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const wantOrg = typeof body.org === "string" ? body.org : null;

  // Only tenants an org has the app on (cached; no DB read per request, and
  // no key fetch for anyone else's tenant).
  const tid = claimedTenant(token);
  if (!tid || !(await teamsAppTenants()).has(tid)) return json(401, { error: "not_signed_in" });

  // Our App ID URI comes from configuration, never the request's Host.
  const origin = configuredPublicOrigin();
  if (!origin) return new Response(null, { status: 503 });
  let id: { tid: string; oid: string };
  try {
    // The app id (a DB read and a decrypt) only once the signature checks out.
    id = await verifyTabToken(token, tid, async () => {
      const appId = await teamsBotAppId();
      return appId ? tabAppIdUri(origin, appId) : null;
    });
  } catch (e) {
    if (e instanceof EntraAuthError && e.reason === "not_configured") return new Response(null, { status: 503 });
    if (e instanceof EntraAuthError) {
      console.warn(`[teams-tab] sign-in refused: ${e.reason}`);
      return json(401, { error: "not_signed_in" });
    }
    throw e;
  }

  const t = rateLimit(`teams-tab-session:tenant:${id.tid}`, { capacity: 300, refillPerSecond: 5 });
  if (!t.allowed) return json(429, { error: "rate_limited" }, { "Retry-After": String(t.retryAfter) });

  const orgs = await teamsOrgsForTenant(id.tid);
  const users = await teamsUsers(orgs, id.tid, id.oid);
  if (!users.length) {
    // Cosmos's front door only: naming the org would tell anyone with a token which orgs the tenant has.
    return json(403, { error: "not_connected", connectUrl: `${origin}/` });
  }
  const u = wantOrg ? users.find((x) => x.slug === wantOrg) : users.length === 1 ? users[0] : null;
  if (!u) return json(409, { error: "choose_org", orgs: users.map((x) => x.slug) });

  return json(200, { org: u.slug }, { "Set-Cookie": tabCookieHeader(sealTabSession({ orgId: u.orgId, userId: u.userId, tid: id.tid, oid: id.oid })) });
}
