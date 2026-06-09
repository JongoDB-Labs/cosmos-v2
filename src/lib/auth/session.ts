import { cookies, headers } from "next/headers";
import { cache } from "react";
import { prisma } from "@/lib/db/client";
import { type AuthContext } from "@/lib/rbac/check";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { isInternalAdmin } from "@/lib/internal/access";
import { ipMatchesAny } from "@/lib/auth/cidr";
import { SESSION_COOKIE } from "./client";

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
 * the sliding window accurate without a DB write per request.
 */
const ACTIVITY_WRITE_THROTTLE_MS = 60_000;

type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  /** SSO assurance, surfaced per-request from the Session row. */
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
};

/**
 * Look up the current session via the session cookie. Returns null if no
 * session cookie is set, the session row is missing, or the session is expired.
 *
 * Wrapped in React's `cache` so multiple callers in the same request share a
 * single DB lookup.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      expiresAt: true,
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
    authMethod: session.authMethod,
    idpConnId: session.idpConnId,
    amr: session.amr,
    mfaSatisfied: session.mfaSatisfied,
    sessionId,
    lastActivityAt: session.lastActivityAt,
  };
});

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
    const user = await getCurrentUser();
    if (!user) return null;

    const org = await prisma.organization.findUnique({
      where: { slug: orgSlug },
    });

    if (!org) return null;

    // Effective permissions fold in work-role grants (widen) + collect ABAC
    // rules; one query, memoized by the cache() wrapper above.
    const effective = await loadEffectivePermissions(org.id, user.id);
    if (!effective) return null;

    // Request-time org security floors, enforced HERE so every org-scoped API
    // route + SSR page inherits them. System admins (INTERNAL_ADMINS) are
    // break-glass exempt from both, so a misconfiguration can't lock the
    // operator out. The per-user MFA enroll endpoints use getCurrentUser (not
    // this), so a denied user can still reach enrollment.
    const sec = await prisma.orgSecuritySettings.findUnique({
      where: { orgId: org.id },
      select: {
        mfaRequired: true,
        ipAllowlistEnabled: true,
        sessionTimeoutMins: true,
      },
    });
    if (sec && !isInternalAdmin(user.email, process.env.INTERNAL_ADMINS)) {
      // Require-MFA: deny a session that doesn't satisfy the org's MFA floor.
      if (sec.mfaRequired && !sessionSatisfiesMfa(user)) return null;

      // Idle timeout (sliding window): deny — and tear down — a session that
      // has gone untouched longer than the org's session-timeout floor. The
      // decision uses lastActivityAt AS READ (before this request's bump) so an
      // expired request can't revive itself; a live request then refreshes the
      // anchor (throttled) so the window slides forward. sessionTimeoutMins <= 0
      // disables the gate.
      if (sec.sessionTimeoutMins > 0) {
        const idleMs = Date.now() - user.lastActivityAt.getTime();
        if (idleMs > sec.sessionTimeoutMins * 60_000) {
          await prisma.session
            .delete({ where: { id: user.sessionId } })
            .catch(() => undefined);
          return null;
        }
        if (idleMs > ACTIVITY_WRITE_THROTTLE_MS) {
          await prisma.session
            .update({
              where: { id: user.sessionId },
              data: { lastActivityAt: new Date() },
            })
            .catch(() => undefined);
        }
      }

      // IP allowlist: when enabled AND at least one CIDR is configured, the
      // client IP must fall within it. An empty list never blocks (anti-lockout).
      if (sec.ipAllowlistEnabled) {
        const rules = await prisma.ipAllowlist.findMany({
          where: { orgId: org.id },
          select: { cidr: true },
        });
        if (rules.length > 0) {
          const h = await headers();
          // Trusted client IP for an ACCESS-CONTROL decision (not just audit).
          // Behind Cloudflare Tunnel → nginx, `cf-connecting-ip` is stamped by
          // Cloudflare at the edge and can't be spoofed by the client (the
          // tunnel is the only ingress), so it's preferred. `x-real-ip` is
          // nginx's view of its immediate peer. The leftmost `x-forwarded-for`
          // hop is client-controlled, so it's the LAST resort (portability for
          // non-Cloudflare deployments) and never wins over the trusted sources.
          const ip = (
            h.get("cf-connecting-ip") ??
            h.get("x-real-ip") ??
            h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
            ""
          ).trim();
          if (!ip || !ipMatchesAny(ip, rules.map((r) => r.cidr))) return null;
        }
      }
    }

    return {
      userId: user.id,
      orgId: org.id,
      orgRole: effective.orgRole,
      permissions: effective.permissions,
      basePermissions: effective.basePermissions,
      abacRules: effective.abacRules,
    };
  },
);
