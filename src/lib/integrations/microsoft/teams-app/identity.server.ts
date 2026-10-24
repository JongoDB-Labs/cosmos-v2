import { prisma } from "@/lib/db/client";
import { getProviderConfig } from "@/lib/auth/provider-config";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { MS_CALENDAR } from "../calendar-connect";

/**
 * COSMOS-202 T1: who a Teams request is for.
 *
 * An org turns the Teams app on by installing "Cosmos for Teams"; it answers
 * only for the Microsoft tenant the org's Outlook Calendar is pinned to. A
 * Teams user is a Cosmos user only through the connection they made
 * themselves (B1): the object id Microsoft signed at connect time equals the
 * activity's from.aadObjectId. Anyone else is unmapped and gets nothing but
 * the "connect your account" card.
 */

/** Integration slug: installing it is the org's switch for the Teams app. */
export const MS_TEAMS_APP = "microsoft-teams-app";

/** The bot's Microsoft app id: the instance's Microsoft sign-in app. */
export async function teamsBotAppId(): Promise<string | null> {
  return (await getProviderConfig("microsoft"))?.clientId ?? null;
}

export interface TeamsOrg {
  orgId: string;
  slug: string;
}

const same = (a: unknown, b: string) => typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Orgs with the Teams app on whose Outlook Calendar is pinned to `tenantId`. */
export async function teamsOrgsForTenant(tenantId: string): Promise<TeamsOrg[]> {
  if (!tenantId) return [];
  const on = await prisma.integration.findMany({
    where: { provider: MS_TEAMS_APP, status: "ACTIVE" },
    select: { orgId: true },
  });
  if (!on.length) return [];
  const calendars = await prisma.integration.findMany({
    where: { provider: MS_CALENDAR, status: "ACTIVE", orgId: { in: on.map((o) => o.orgId) } },
    select: { orgId: true, config: true, org: { select: { slug: true } } },
  });
  return calendars
    .filter((c) => same((c.config as { tenantId?: unknown } | null)?.tenantId, tenantId))
    .map((c) => ({ orgId: c.orgId, slug: c.org.slug }));
}

/** Does this org have the Teams app on (and something to pin it to)? */
export async function teamsAppEnabled(orgId: string): Promise<boolean> {
  const [app, cal] = await Promise.all([
    prisma.integration.findFirst({ where: { orgId, provider: MS_TEAMS_APP, status: "ACTIVE" }, select: { id: true } }),
    prisma.integration.findFirst({ where: { orgId, provider: MS_CALENDAR, status: "ACTIVE" }, select: { config: true } }),
  ]);
  const tid = (cal?.config as { tenantId?: unknown } | null)?.tenantId;
  return !!app && typeof tid === "string" && !!tid.trim();
}

export interface TeamsUser extends TeamsOrg {
  userId: string;
  /** The person's own access, as an interactive (not API-key) caller. */
  auth: AuthContext;
}

/**
 * The Cosmos accounts this Teams user connected, one per org that answers for
 * the tenant. Empty when they never connected, or left, or were deactivated.
 */
export async function teamsUsers(orgs: TeamsOrg[], tenantId: string, aadObjectId: string): Promise<TeamsUser[]> {
  if (!orgs.length || !aadObjectId) return [];
  const creds = await prisma.connectorCredential.findMany({
    where: { provider: MS_CALENDAR, orgId: { in: orgs.map((o) => o.orgId) }, meta: { path: ["oid"], equals: aadObjectId } },
    select: { orgId: true, userId: true, meta: true },
  });
  const out: TeamsUser[] = [];
  for (const c of creds) {
    const meta = c.meta as { oid?: unknown; tid?: unknown };
    if (!c.userId || !same(meta.oid, aadObjectId) || !same(meta.tid, tenantId)) continue;
    const user = await prisma.user.findUnique({ where: { id: c.userId }, select: { deactivatedAt: true } });
    if (!user || user.deactivatedAt) continue;
    const auth = await loadMemberAuthContext(c.orgId, c.userId);
    if (!auth) continue;
    out.push({ ...orgs.find((o) => o.orgId === c.orgId)!, userId: c.userId, auth: { ...auth, isApiKey: false } });
  }
  return out;
}

const TENANTS_TTL_MS = 60_000;
let tenants: { set: Set<string>; at: number } | null = null;

/**
 * Tenants some org has the Teams app on for, cached for a minute: lets an
 * unauthenticated endpoint refuse a token from any other tenant without a
 * database read per request, and without fetching keys for it.
 */
export async function teamsAppTenants(now = Date.now()): Promise<Set<string>> {
  if (tenants && now - tenants.at < TENANTS_TTL_MS) return tenants.set;
  const on = await prisma.integration.findMany({ where: { provider: MS_TEAMS_APP, status: "ACTIVE" }, select: { orgId: true } });
  const cal = on.length
    ? await prisma.integration.findMany({ where: { provider: MS_CALENDAR, status: "ACTIVE", orgId: { in: on.map((o) => o.orgId) } }, select: { config: true } })
    : [];
  const set = new Set(
    cal.map((c) => (c.config as { tenantId?: unknown } | null)?.tenantId).filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim().toLowerCase()),
  );
  tenants = { set, at: now };
  return set;
}

/** For tests: forget the cached tenant list. */
export function _resetTeamsAppTenants() {
  tenants = null;
}
