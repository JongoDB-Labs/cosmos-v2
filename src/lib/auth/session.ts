import { cookies } from "next/headers";
import { cache } from "react";
import { prisma } from "@/lib/db/client";
import { type AuthContext } from "@/lib/rbac/check";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { SESSION_COOKIE } from "./client";

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
  };
});

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
