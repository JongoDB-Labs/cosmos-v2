import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { openSecret, sealSecret } from "@/lib/crypto/vault";
import { getProviderConfig } from "@/lib/auth/provider-config";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { microsoftGraphOrigin, microsoftLoginOrigin } from "./hosts";
import { MS_CALENDAR, MS_CALENDAR_SCOPES, idTokenClaims, type IdClaims } from "./calendar-connect";
import {
  effectiveSharingLevel,
  orgSharingLevel,
  userSharingLevel,
  type SharingLevel,
} from "./calendar-sharing";

/**
 * COSMOS-202 (B1): a connected person's Microsoft Graph access token.
 *
 * - The REFRESH token is the only thing stored, sealed in ConnectorCredential.
 *   Access tokens live in memory and expire with the process.
 * - Refreshing is single-flight per person in this process, and serialised
 *   across processes by a Postgres advisory lock held ONLY around the refresh.
 *   Microsoft rotates the refresh token; the new one is always written back.
 * - A refresh token Microsoft has revoked or expired (invalid_grant, or consent
 *   withdrawn) flips the connection to "reconnect" and stops there: no retries,
 *   no loop. The person sees a Reconnect button.
 * - Every use re-checks that the connection should still exist (org switch on,
 *   tenant unchanged, person still an active member). One that shouldn't is
 *   deleted, not just refused.
 */

export class CalendarNotConnected extends Error {}
export class CalendarReconnectNeeded extends Error {}

export interface CalendarMeta {
  tid: string;
  oid: string;
  upn: string;
  /** The mailbox's primary SMTP address, when it differs from the UPN's form. */
  mail?: string;
  scopes: string[];
  status: "connected" | "reconnect";
  connectedAt: string;
  lastRefreshAt?: string;
  origin?: string;
  /** The dedicated "Cosmos" calendar we write to (B2). */
  calendarId?: string;
  /** Graph calendarView delta link for the next pull (B2). */
  deltaLink?: string;
  /** When the delta's window ends; the pull restarts it before then (B2). */
  windowEnd?: string;
  lastSyncAt?: string;
  /** How much this person publishes; unset follows the org's default. */
  sharingLevel?: SharingLevel;
  [k: string]: unknown;
}

type FetchFn = typeof fetch;
interface Deps {
  fetch?: FetchFn;
  now?: () => number;
}

const LOCK_NAMESPACE = 20202;
const REFRESH_TIMEOUT_MS = 15_000;
/** Refresh this long before the access token actually expires. */
const EARLY_MS = 5 * 60_000;

const cache = new Map<string, { token: string; exp: number }>();
const inflight = new Map<string, Promise<string>>();
const key = (orgId: string, userId: string) => `${orgId}:${userId}`;

/** Forget one person's cached access token (Graph said it was no good). */
export function _forgetCalendarAccessToken(orgId: string, userId: string) {
  cache.delete(key(orgId, userId));
}

/** For tests: forget cached access tokens. */
export function _resetCalendarTokenCache() {
  cache.clear();
  inflight.clear();
}

export interface OrgCalendarConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
}

/**
 * The org's switch and app credentials, or null when the org can't connect
 * calendars: integration not installed or not ACTIVE, no tenant pinned, or the
 * instance's Microsoft app not configured.
 */
export async function orgCalendarConfig(orgId: string, opts: { anyStatus?: boolean } = {}): Promise<OrgCalendarConfig | null> {
  const integration = await prisma.integration.findFirst({
    where: { orgId, provider: MS_CALENDAR, ...(opts.anyStatus ? {} : { status: "ACTIVE" as const }) },
    select: { config: true },
  });
  const tenantId = (integration?.config as { tenantId?: unknown } | null)?.tenantId;
  if (typeof tenantId !== "string" || !tenantId.trim()) return null;
  const app = await getProviderConfig("microsoft");
  if (!app) return null;
  return { clientId: app.clientId, clientSecret: app.clientSecret, tenantId: tenantId.trim() };
}

/** The org-wide default sharing level, from the org's settings. */
export async function orgSharingDefault(orgId: string): Promise<SharingLevel> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  return orgSharingLevel(org?.settings);
}

export interface CalendarSharingState {
  /** This person's own choice, or "default" while they follow the org's. */
  level: SharingLevel | "default";
  orgDefault: SharingLevel;
  /** What is actually published for them. */
  effective: SharingLevel;
}

/** The sharing level a person is on, and the org default behind it. */
export async function calendarSharingState(orgId: string, meta?: CalendarMeta | null): Promise<CalendarSharingState> {
  const orgDefault = await orgSharingDefault(orgId);
  const own = userSharingLevel(meta);
  return { level: own ?? "default", orgDefault, effective: effectiveSharingLevel(orgDefault, own) };
}

/** What Cosmos publishes into this person's Outlook: their choice, else the org's. */
export async function sharingLevelFor(orgId: string, meta: CalendarMeta): Promise<SharingLevel> {
  return (await calendarSharingState(orgId, meta)).effective;
}

class TokenEndpointError extends Error {
  constructor(public status: number, public code: string) {
    super(`microsoft token endpoint: ${status} ${code}`);
  }
  /** Microsoft says this refresh token will never work again. */
  get revoked() {
    return ["invalid_grant", "interaction_required", "consent_required", "invalid_client"].includes(this.code);
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

async function tokenRequest(cfg: OrgCalendarConfig, params: Record<string, string>, f: FetchFn): Promise<TokenResponse> {
  const res = await f(`${microsoftLoginOrigin()}/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: MS_CALENDAR_SCOPES.join(" "), ...params }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!res.ok || !body.access_token) throw new TokenEndpointError(res.status, body.error ?? "unknown_error");
  return body as TokenResponse;
}

/**
 * Finish a connect: trade the code for tokens, refuse an account from any
 * tenant but the org's, and store the sealed refresh token. Returns the claims
 * so the caller can audit-log who connected.
 */
/**
 * The mailbox's primary SMTP address (Graph /me `mail`). In some tenants it
 * differs from the UPN, and calendars report their owner by it. Best effort:
 * without it, matching falls back to the UPN.
 */
async function mailboxAddress(accessToken: string, f: typeof fetch): Promise<string | undefined> {
  try {
    const res = await f(`${microsoftGraphOrigin()}/v1.0/me?$select=mail,userPrincipalName`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { mail?: unknown };
    return typeof body.mail === "string" && body.mail.includes("@") ? body.mail : undefined;
  } catch {
    return undefined;
  }
}

export async function completeCalendarConnect(
  a: { orgId: string; userId: string; code: string; verifier: string; redirectUri: string; origin?: string },
  deps: Deps = {},
): Promise<IdClaims> {
  const cfg = await orgCalendarConfig(a.orgId);
  if (!cfg) throw new CalendarNotConnected("Outlook Calendar isn't turned on for this organization.");
  const t = await tokenRequest(
    cfg,
    { grant_type: "authorization_code", code: a.code, redirect_uri: a.redirectUri, code_verifier: a.verifier },
    deps.fetch ?? fetch,
  );
  const claims = idTokenClaims(t.id_token);
  if (!claims) throw new CalendarNotConnected("Microsoft didn't say which account this is.");
  if (claims.tid.toLowerCase() !== cfg.tenantId.toLowerCase()) {
    throw new CalendarNotConnected("That Microsoft account belongs to a different organization.");
  }
  if (!t.refresh_token) throw new CalendarNotConnected("Microsoft didn't grant offline access.");
  const now = (deps.now ?? Date.now)();
  const existing = await prisma.connectorCredential.findFirst({
    where: { orgId: a.orgId, provider: MS_CALENDAR, userId: a.userId },
    select: { id: true, meta: true },
  });
  const prev = existing?.meta as CalendarMeta | undefined;
  // A reconnect with the SAME Microsoft account keeps its sync state (its
  // "Cosmos" calendar and delta position), so nothing is recreated. A different
  // account starts clean: the old event links point into someone else's mailbox.
  const sameAccount = !!prev && prev.oid === claims.oid && prev.tid?.toLowerCase() === claims.tid.toLowerCase();
  const keep = (keys: readonly (keyof CalendarMeta)[]): Partial<CalendarMeta> =>
    Object.fromEntries(keys.filter((k) => prev?.[k] !== undefined).map((k) => [k, prev![k]]));
  const kept: Partial<CalendarMeta> = {
    // Their sharing level is a preference, not sync state: it survives any
    // reconnect, including one onto a different Microsoft account.
    ...keep(["sharingLevel"]),
    ...(sameAccount ? keep(["calendarId", "deltaLink", "windowEnd", "lastSyncAt"]) : {}),
  };
  const mail = await mailboxAddress(t.access_token, deps.fetch ?? fetch);
  const meta: CalendarMeta = {
    ...claims,
    ...(mail ? { mail } : {}),
    scopes: MS_CALENDAR_SCOPES,
    status: "connected",
    connectedAt: new Date(now).toISOString(),
    // The public address they connected from: links in synced events use it.
    ...(a.origin ? { origin: a.origin } : {}),
    ...kept,
  };
  const secretEnc = sealSecret(JSON.stringify({ refreshToken: t.refresh_token }));
  if (existing) {
    await prisma.connectorCredential.update({ where: { id: existing.id }, data: { secretEnc, meta: meta as Prisma.InputJsonValue } });
    if (!sameAccount) {
      await prisma.externalEventLink.deleteMany({ where: { orgId: a.orgId, provider: MS_CALENDAR, userId: a.userId } });
    }
  } else {
    await prisma.connectorCredential.create({
      data: { orgId: a.orgId, provider: MS_CALENDAR, userId: a.userId, secretEnc, meta: meta as Prisma.InputJsonValue },
    });
  }
  cache.set(key(a.orgId, a.userId), { token: t.access_token, exp: now + (t.expires_in ?? 3600) * 1000 });
  return claims;
}

/**
 * Merge `patch` into a connection's meta (and drop `remove` keys) in one
 * statement, so two writers (a token refresh and a sync) never overwrite each
 * other's fields.
 */
export async function patchCalendarMeta(
  credId: string,
  patch: Partial<CalendarMeta>,
  remove: string[] = [],
  db: Pick<Prisma.TransactionClient, "$executeRaw"> = prisma,
): Promise<void> {
  await db.$executeRaw`
    UPDATE connector_credentials
       SET meta = (meta || ${JSON.stringify(patch)}::jsonb) - ${remove}::text[], updated_at = now()
     WHERE id = ${credId}::uuid`;
}

export async function calendarConnection(orgId: string, userId: string) {
  const row = await prisma.connectorCredential.findFirst({
    where: { orgId, provider: MS_CALENDAR, userId },
    select: { id: true, meta: true, updatedAt: true },
  });
  return row ? { id: row.id, meta: row.meta as unknown as CalendarMeta, updatedAt: row.updatedAt } : null;
}

/** Delete one person's connection. Idempotent. */
export async function disconnectCalendar(orgId: string, userId: string): Promise<boolean> {
  cache.delete(key(orgId, userId));
  // The event links go with the token: nothing is left to sync against. So
  // does their Teams chat with the bot (COSMOS-202 T2): it was theirs only
  // through this link.
  const [r] = await prisma.$transaction([
    prisma.connectorCredential.deleteMany({ where: { orgId, provider: MS_CALENDAR, userId } }),
    prisma.externalEventLink.deleteMany({ where: { orgId, provider: MS_CALENDAR, userId } }),
    prisma.teamsConversation.deleteMany({ where: { orgId, userId } }),
  ]);
  return r.count > 0;
}

/** Delete every person's connection in an org (the admin turned it off). */
export async function purgeOrgCalendarConnections(orgId: string): Promise<number> {
  for (const k of cache.keys()) if (k.startsWith(`${orgId}:`)) cache.delete(k);
  // Teams (T2) answers only for the tenant Outlook is pinned to: its chats and channels go too.
  const [r] = await prisma.$transaction([
    prisma.connectorCredential.deleteMany({ where: { orgId, provider: MS_CALENDAR, userId: { not: null } } }),
    prisma.externalEventLink.deleteMany({ where: { orgId, provider: MS_CALENDAR } }),
    prisma.teamsConversation.deleteMany({ where: { orgId } }),
  ]);
  return r.count;
}

/**
 * Should this connection still exist? If not, it is deleted here, so a person
 * who left, or an org that switched the integration off, keeps no token.
 */
export type OffboardReason = "integration_disabled" | "organizer_left" | "organizer_deactivated" | "tenant_changed";
type OffboardHook = (orgId: string, userId: string, reason: OffboardReason, deps: Deps) => Promise<void>;
const offboardHooks: OffboardHook[] = [];

/** Run `hook` just before a connection is removed because it may no longer exist. */
export function onCalendarOffboard(hook: OffboardHook) {
  if (!offboardHooks.includes(hook)) offboardHooks.push(hook);
}

async function ensureStillAllowed(orgId: string, userId: string, deps: Deps): Promise<{ cfg: OrgCalendarConfig; meta: CalendarMeta }> {
  const conn = await calendarConnection(orgId, userId);
  if (!conn) throw new CalendarNotConnected("Outlook Calendar isn't connected.");
  const [cfg, user, eff] = await Promise.all([
    orgCalendarConfig(orgId),
    prisma.user.findUnique({ where: { id: userId }, select: { deactivatedAt: true } }),
    loadEffectivePermissions(orgId, userId),
  ]);
  const tenantMoved = cfg && conn.meta.tid?.toLowerCase() !== cfg.tenantId.toLowerCase();
  if (!cfg || !user || user.deactivatedAt || !eff || tenantMoved) {
    const reason: OffboardReason = !cfg ? "integration_disabled" : !user || !eff ? "organizer_left" : user.deactivatedAt ? "organizer_deactivated" : "tenant_changed";
    // Last chance to act in their mailbox (cancel the invitations they send),
    // while the token still exists. Never blocks the removal.
    for (const hook of offboardHooks) await hook(orgId, userId, reason, deps).catch(() => undefined);
    await disconnectCalendar(orgId, userId);
    throw new CalendarNotConnected("Outlook Calendar is no longer connected.");
  }
  if (conn.meta.status === "reconnect") throw new CalendarReconnectNeeded("Reconnect Outlook Calendar.");
  return { cfg, meta: conn.meta };
}

/**
 * A Graph access token for this person, refreshing if needed.
 * Throws CalendarNotConnected or CalendarReconnectNeeded; never loops.
 */
export async function calendarAccessToken(orgId: string, userId: string, deps: Deps & { offboarding?: boolean } = {}): Promise<string> {
  const now = deps.now ?? Date.now;
  // Offboarding (an offboard hook cleaning up as the connection goes): the
  // connection must still exist, but the allowed-checks are what removed it.
  let cfg: OrgCalendarConfig | null;
  if (deps.offboarding) {
    const conn = await calendarConnection(orgId, userId);
    cfg = conn && conn.meta.status === "connected" ? await orgCalendarConfig(orgId, { anyStatus: true }) : null;
    if (!cfg) throw new CalendarNotConnected("Outlook Calendar isn't connected.");
  } else {
    ({ cfg } = await ensureStillAllowed(orgId, userId, deps));
  }
  const k = key(orgId, userId);
  const hit = cache.get(k);
  if (hit && hit.exp - EARLY_MS > now()) return hit.token;
  const running = inflight.get(k);
  if (running) return running;
  const p = refresh(orgId, userId, cfg, deps).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

async function refresh(orgId: string, userId: string, cfg: OrgCalendarConfig, deps: Deps): Promise<string> {
  const now = deps.now ?? Date.now;
  const f = deps.fetch ?? fetch;
  const outcome = await prisma.$transaction(
    async (tx) => {
      // Serialise refreshes for this person across processes. Released when the
      // transaction ends; held only for this read-refresh-write.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, hashtext(${`${orgId}:${userId}`}))`;
      // Re-read under the lock: another process may have just rotated it.
      const row = await tx.connectorCredential.findFirst({
        where: { orgId, provider: MS_CALENDAR, userId },
        select: { id: true, secretEnc: true, meta: true },
      });
      if (!row) return { kind: "gone" as const };
      const { refreshToken } = JSON.parse(openSecret(row.secretEnc)) as { refreshToken: string };
      try {
        const t = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, f);
        if (t.refresh_token) {
          await tx.connectorCredential.update({
            where: { id: row.id },
            data: { secretEnc: sealSecret(JSON.stringify({ refreshToken: t.refresh_token })) },
          });
        }
        // Merged in place, so a concurrent sync's delta position is never lost.
        await patchCalendarMeta(row.id, { status: "connected", lastRefreshAt: new Date(now()).toISOString() }, [], tx);
        return { kind: "ok" as const, token: t.access_token, exp: now() + (t.expires_in ?? 3600) * 1000 };
      } catch (e) {
        if (e instanceof TokenEndpointError && e.revoked) {
          // Recorded inside the transaction, which then COMMITS: returning,
          // not throwing, is what keeps this write.
          await patchCalendarMeta(row.id, { status: "reconnect" }, [], tx);
          return { kind: "revoked" as const };
        }
        throw e;
      }
    },
    { timeout: REFRESH_TIMEOUT_MS + 5_000, maxWait: 10_000 },
  );
  if (outcome.kind === "gone") throw new CalendarNotConnected("Outlook Calendar isn't connected.");
  if (outcome.kind === "revoked") throw new CalendarReconnectNeeded("Reconnect Outlook Calendar.");
  cache.set(`${orgId}:${userId}`, { token: outcome.token, exp: outcome.exp });
  return outcome.token;
}
