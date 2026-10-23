import type { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import type { ToolContext } from "@/lib/ai/executors/_ctx";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";

/**
 * Caller contexts for the AI-tool specs.
 *
 * Imported only from `*.test.ts`. Every tool call now carries the caller's own
 * AuthContext (see `lib/ai/executors/_ctx.ts`): the executors authorise against
 * it and refuse a call without one. These build that context the two ways a
 * spec needs it.
 */

/**
 * A literal AuthContext — for specs that mock the database and decide the
 * actor's permissions themselves. Defaults to a MEMBER holding nothing, so a
 * spec that forgets to say what the actor may do gets refusals, not access.
 */
export function stubAuth(
  orgId: string,
  userId: string,
  over: Partial<Omit<AuthContext, "orgId" | "userId">> = {},
): AuthContext {
  const permissions = over.permissions ?? 0n;
  return {
    orgId,
    userId,
    orgRole: "MEMBER" as OrgRole,
    permissions,
    basePermissions: over.basePermissions ?? permissions,
    abacRules: [],
    ...over,
  };
}

/** `{ orgId, userId, auth }` around `stubAuth`. */
export function stubToolCtx(
  orgId: string,
  userId: string,
  over: Partial<Omit<AuthContext, "orgId" | "userId">> = {},
): ToolContext {
  return { orgId, userId, auth: stubAuth(orgId, userId, over) };
}

/**
 * The context a logged-in session for `userId` would produce, read from the
 * seeded database — for the DB-backed specs.
 *
 * A NON-member has no session context at all, so for one this returns a
 * context WITHOUT `auth`. That is deliberate: it is exactly what the executors
 * must refuse, and it keeps the existing "non-member is denied" cases asserting
 * the fail-closed path rather than an invented zero-permission member.
 */
export async function memberToolCtx(orgId: string, userId: string): Promise<ToolContext> {
  const auth = await loadMemberAuthContext(orgId, userId);
  return (auth ? { orgId, userId, auth } : { orgId, userId }) as ToolContext;
}
