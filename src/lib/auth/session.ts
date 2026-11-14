import { cookies, headers } from "next/headers";
import { cache } from "react";
import { prisma } from "@/lib/db/client";
import { type AuthContext } from "@/lib/rbac/check";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { isSystemAdmin, type SystemAdminSubject } from "@/lib/internal/access";
import { admitsAddress, allowlistState } from "@/lib/auth/ip-allowlist";
import { trustedClientIp } from "@/lib/auth/client-ip";
import { SESSION_COOKIE } from "./client";
import { verifyApiKeyHeader } from "./api-key";
import { classifyBearer } from "./bearer";
import { orgSessionRefusal } from "./org-session-scope";

/**
 * Whether a session satisfies an org's Require-MFA floor, under the
 * "provider-trusted" policy: a federated login (Google / Microsoft / SSO, i.e.
 * any authMethod that isn't first-party "password") is trusted to have done its
 * own MFA; a first-party password login only counts once it completed TOTP
 * (mfaSatisfied). Legacy sessions (authMethod null) are treated as federated.
 */
function sessionSatisfiesMfa(user: {
  authMethod: string | null;
  mfaSatisfied: boolean;
}): boolean {
  return user.mfaSatisfied || user.authMethod !== "password";
}

/**
 * Don't write `lastActivityAt` on every request — only once the anchor is this
 * stale. Idle timeouts are configured in minutes, so a 60s write throttle keeps
 * the sliding window accurate without a DB write per request. A window shorter
 * than two minutes is stamped at least twice per window instead (see below),
 * or a steadily active session would lapse between two stamps.
 */
const ACTIVITY_WRITE_THROTTLE_MS = 60_000;

/** The stricter of two minute limits where 0 (or less) means "off"; 0 when both are off. */
function strictestLimit(a: number, b: number): number {
  const on = [a, b].filter((m) => m > 0);
  return on.length ? Math.min(...on) : 0;
}

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  /** The account was created by an organization's IdP (never a system admin). */
  ssoProvisioned: boolean;
  /** First-party credentials bound to the account (see lib/internal/access). */
  googleBound: boolean;
  microsoftBound: boolean;
  passwordUntrusted: boolean;
  /** How the session signed in, and SSO assurance, from the Session row. */
  authMethod: string | null;
  idpConnId: string | null;
  amr: string[];
  mfaSatisfied: boolean;
  /** The authenticating Session's id + sliding-window idle anchor, used by
   * getAuthContext to enforce the org's session-timeout floor (read here as a
   * pure value; the throttled write lives in getAuthContext where the policy
   * is known, so an idle-expired request can't revive its own session). */
  sessionId: string;
  lastActivityAt: Date;
  /** When the session was created, for the org's absolute session-age cap. */
  sessionCreatedAt: Date;
};

/**
 * Look up the current session via the session cookie. Returns null if no
 * session cookie is set, the session row is missing, or the session is expired.
 *
 * Also null whenever the request presents a Cosmos bearer (`Bearer cosmos_…`,
 * valid or not), the rule getAuthContext follows too: such a request is judged
 * by its bearer alone, never by a cookie riding along. The proxy skips its
 * same-origin check for a key-shaped bearer, checking only the shape, so a
 * cookie fallback would let another site's page act as whoever's browser it
 * runs in by sending any key-shaped string.
 *
 * Wrapped in React's `cache` so multiple callers in the same request share a
 * single DB lookup.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  if (classifyBearer((await headers()).get("authorization")) !== null) return null;
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;
  return getSessionUser(sessionId);
});

/**
 * The live session `sessionId` names, as getCurrentUser reads it. For route
 * handlers that hold the cookie on the request (an OAuth callback that must
 * know who is signed in), so they read the same fields the same way.
 */
export async function getSessionUser(sessionId: string): Promise<SessionUser | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      expiresAt: true,
      createdAt: true,
      lastActivityAt: true,
      authMethod: true,
      idpConnId: true,
      amr: true,
      mfaSatisfied: true,
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          ssoProvisioned: true,
          googleId: true,
          passwordUntrusted: true,
          microsoftIdentity: { select: { id: true } },
        },
      },
    },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  return {
    id: session.user.id,
    email: session.user.email,
    displayName: session.user.displayName,
    avatarUrl: session.user.avatarUrl,
    ssoProvisioned: session.user.ssoProvisioned,
    googleBound: session.user.googleId != null,
    microsoftBound: session.user.microsoftIdentity != null,
    passwordUntrusted: session.user.passwordUntrusted,
    authMethod: session.authMethod,
    idpConnId: session.idpConnId,
    amr: session.amr,
    mfaSatisfied: session.mfaSatisfied,
    sessionId,
    lastActivityAt: session.lastActivityAt,
    sessionCreatedAt: session.createdAt,
  };
}

/**
 * Whether a session that authenticated a request earlier still would: its row
 * still exists (signing out and revocation delete it), it has not expired, the
 * org still opens to it (`orgSessionRefusal`: an SSO session opens only its
 * IdP's org, and an org that requires SSO only its own SSO sessions), and the
 * org's floors still admit it from the address it connected from
 * (`orgSessionFloors`). The same checks `getAuthContext` makes. For a
 * long-lived connection, the org event stream, which authenticates once and
 * must not outlive its session. Reads only: holding a stream open is not
 * activity, so it never slides the idle window.
 */
export async function sessionStillValid(sessionId: string, orgId: string, clientIp: string | null): Promise<boolean> {
  const user = await getSessionUser(sessionId);
  if (!user) return false;
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, tenantClass: true } });
  if (!org || (await orgSessionRefusal(user, org))) return false;
  const floors = await orgSessionFloors(orgId, user, clientIp);
  return floors.ok;
}

type FloorVerdict =
  | { ok: true; /** The idle limit in minutes, 0 when off; a live request slides its window. */ idleLimitMins: number }
  | { ok: false; why: "mfa" | "age" | "idle" | "concurrent" | "ip" };

/**
 * The org's floors for a session: Require-MFA, the session age cap, the idle
 * timeout, the sessions-per-person cap and the IP allowlist. The ONE copy:
 * `getAuthContext` applies it to every request and `sessionStillValid` to a
 * stream that stays open, so the two cannot drift (a second copy for the
 * stream once had only the idle timeout). Both pass the SessionUser that
 * `getSessionUser` read, so there is one session query. A platform admin
 * (`isSystemAdmin`: an INTERNAL_ADMINS address on a session that vouches for
 * it) is break-glass exempt from all of them, so a misconfiguration can't lock
 * the operator out. Reads only; the idle decision uses `lastActivityAt` as
 * read, so a request cannot revive its own session.
 *
 * `clientIp` is the request's trusted address (`trustedClientIp`, which reads
 * only the header the deployment's edge writes); a stream passes the one it
 * opened from. The allowlist itself is the one ip-allowlist.ts reads for every
 * door (`allowlistState`, `admitsAddress`).
 */
async function orgSessionFloors(
  orgId: string,
  session: SystemAdminSubject &
    Pick<SessionUser, "id" | "sessionId" | "mfaSatisfied" | "lastActivityAt" | "sessionCreatedAt">,
  clientIp: string | null,
): Promise<FloorVerdict> {
  const sec = await prisma.orgSecuritySettings.findUnique({
    where: { orgId },
    select: {
      mfaRequired: true,
      ipAllowlistEnabled: true,
      sessionTimeoutMins: true,
      idleTimeoutMins: true,
      maxSessionAgeMins: true,
      maxConcurrentSessions: true,
    },
  });
  if (!sec || isSystemAdmin(session)) return { ok: true, idleLimitMins: 0 };
  if (sec.mfaRequired && !sessionSatisfiesMfa(session)) return { ok: false, why: "mfa" };

  const now = Date.now();
  // Absolute age: a session older than maxSessionAgeMins stops working in this
  // org however active it has been. Refused, not deleted: a Session is the
  // person's in every org they belong to, and only this one set the cap. 0
  // disables it.
  if (sec.maxSessionAgeMins > 0 && now - session.sessionCreatedAt.getTime() > sec.maxSessionAgeMins * 60_000) {
    return { ok: false, why: "age" };
  }

  // Idle timeout (sliding window): the stricter of sessionTimeoutMins and
  // idleTimeoutMins. 0 disables either one.
  const idleLimitMins = strictestLimit(sec.sessionTimeoutMins, sec.idleTimeoutMins);
  if (idleLimitMins > 0 && now - session.lastActivityAt.getTime() > idleLimitMins * 60_000) {
    return { ok: false, why: "idle" };
  }

  // Concurrent sessions: only the person's maxConcurrentSessions newest live
  // sessions work in this org, so signing in again elsewhere retires the
  // oldest. Refused, not deleted (see the age cap). 0 disables it. Only
  // sessions this org would accept count: one it refuses anyway (no MFA where
  // MFA is required, past the age cap, idle too long) must not take a slot
  // from one it accepts.
  if (sec.maxConcurrentSessions > 0) {
    const newest = await prisma.session.findMany({
      where: {
        userId: session.id,
        expiresAt: { gt: new Date(now) },
        ...(sec.maxSessionAgeMins > 0 ? { createdAt: { gte: new Date(now - sec.maxSessionAgeMins * 60_000) } } : {}),
        ...(idleLimitMins > 0 ? { lastActivityAt: { gte: new Date(now - idleLimitMins * 60_000) } } : {}),
        // sessionSatisfiesMfa, as a query: SQL's `<>` skips NULL, so a legacy
        // session (authMethod null) is named outright.
        ...(sec.mfaRequired
          ? { OR: [{ mfaSatisfied: true }, { authMethod: { not: "password" } }, { authMethod: null }] }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: sec.maxConcurrentSessions,
      select: { id: true },
    });
    if (!newest.some((s) => s.id === session.sessionId)) return { ok: false, why: "concurrent" };
  }

  if (sec.ipAllowlistEnabled && !admitsAddress(clientIp, await allowlistState(orgId))) return { ok: false, why: "ip" };
  return { ok: true, idleLimitMins };
}

/**
 * Revoke (terminate) all sessions for every member of an org. Deletes the global
 * `Session` rows so they stop authenticating immediately, and marks the org's
 * `SessionRecord` rows REVOKED for the audit-view mirror.
 *
 * Called when an org tightens its auth posture — e.g. a GOV org enabling
 * `ssoEnforced` or `mfaRequired` — so existing weaker-assurance sessions (Google
 * / pre-enforcement OIDC) can't ride past the new floor. A global `Session` is
 * per-user (not per-org), so a member belonging to multiple orgs is logged out
 * everywhere; that's the intended fail-safe when a gov tenant raises the bar.
 *
 * TODO(sso-followon): SCIM deprovisioning (`active:false`) and OIDC back-channel
 * logout (SLO) must ALSO call this (scoped to the affected user) to terminate
 * sessions when an identity is disabled upstream. Not wired in this slice.
 *
 * Returns the number of global Session rows deleted.
 */
export async function revokeOrgSessions(orgId: string): Promise<number> {
  const members = await prisma.orgMember.findMany({
    where: { orgId },
    select: { userId: true },
  });
  const userIds = members.map((m) => m.userId);
  if (userIds.length === 0) return 0;

  // Delete the authenticating Session rows for all of the org's members.
  const deleted = await prisma.session.deleteMany({
    where: { userId: { in: userIds } },
  });

  // Mark this org's active SessionRecord mirrors REVOKED (best-effort; the
  // Session delete above is what actually terminates auth).
  await prisma.sessionRecord
    .updateMany({
      where: { orgId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date() },
    })
    .catch(() => undefined);

  return deleted.count;
}

/**
 * Auth context for org-scoped API routes. Returns `null` when:
 * - no valid session,
 * - the user has no row in `users`,
 * - the org slug doesn't exist,
 * - or the user has no membership in that org.
 *
 * Shape preserved from the previous Auth0 implementation so existing route
 * handlers can keep destructuring `{ userId, orgId, orgRole, permissions }`.
 */
export const getAuthContext = cache(
  async (orgSlug: string): Promise<AuthContext | null> => {
    const org = await prisma.organization.findUnique({
      where: { slug: orgSlug },
    });

    if (!org) return null;

    // ── API key ──────────────────────────────────────────────────────────────
    // Checked BEFORE the session, and only when the request actually carries a
    // cosmos bearer token, so nothing about the cookie path changes.
    //
    // This is the single place org-scoped routes resolve an actor, which is why
    // the key path belongs here: `verifyApiKey` was written, tested and wired to
    // NOTHING, so every key was minted, displayed in settings, and then rejected
    // by every endpoint with a 401 that looked like a bad key.
    //
    // The key's grant is already its minting user's permissions ∩ its scope mask
    // (see verifyApiKeyHeader), so it can never widen what that user could do.
    // Session-shaped floors (Require-MFA, idle timeout) are deliberately not
    // applied: they are properties of an interactive login, and a key has its own
    // expiry and revocation. The IP allowlist IS applied (inside
    // verifyApiKeyHeader, which resolveAuth's key path shares): that one is
    // about where a request comes from, which is just as true of a key.
    //
    // Any Cosmos bearer (classifyBearer non-null) decides the request on its
    // own: one that is not a valid API key returns null here and never falls
    // through to the cookie below.
    const requestHeaders = await headers();
    const authorization = requestHeaders.get("authorization");
    const bearer = classifyBearer(authorization);
    if (bearer !== null) {
      if (bearer !== "api_key") return null;
      return verifyApiKeyHeader(authorization, org.id, requestHeaders);
    }

    const user = await getCurrentUser();
    if (!user) return null;

    // Which orgs this session may open at all: an SSO session opens only its own
    // IdP's org, and an org that requires SSO opens only to its IdP's sessions
    // (or a platform admin's own first-party one). See lib/auth/org-session-scope.
    if (await orgSessionRefusal(user, org)) return null;

    // Effective permissions fold in work-role grants (widen) + collect ABAC
    // rules; one query, memoized by the cache() wrapper above.
    const effective = await loadEffectivePermissions(org.id, user.id);
    if (!effective) return null;

    // Request-time org security floors (Require-MFA, session age, idle
    // timeout, sessions per person, IP allowlist), enforced HERE so every
    // org-scoped API route + SSR page inherits them. The per-user MFA enroll endpoints use getCurrentUser (not
    // this), so a denied user can still reach enrollment.
    const floors = await orgSessionFloors(org.id, user, trustedClientIp(requestHeaders));
    if (!floors.ok) {
      // Idle past the timeout: tear the session down, not just this request.
      if (floors.why === "idle") {
        await prisma.session
          .delete({ where: { id: user.sessionId } })
          .catch(() => undefined);
      }
      return null;
    }
    // A live request slides the idle window forward (throttled).
    if (
      floors.idleLimitMins > 0 &&
      Date.now() - user.lastActivityAt.getTime() > Math.min(ACTIVITY_WRITE_THROTTLE_MS, (floors.idleLimitMins * 60_000) / 2)
    ) {
      await prisma.session
        .update({
          where: { id: user.sessionId },
          data: { lastActivityAt: new Date() },
        })
        .catch(() => undefined);
    }

    return {
      userId: user.id,
      orgId: org.id,
      orgRole: effective.orgRole,
      permissions: effective.permissions,
      basePermissions: effective.basePermissions,
      unrestrictedBasePermissions: effective.unrestrictedBasePermissions,
      abacRules: effective.abacRules,
    };
  },
);
