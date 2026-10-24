import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { effectiveScopes } from "@/lib/auth/api-key-scopes";
import type { AuthContext } from "@/lib/rbac/check";
import type { RouteContract } from "./contract";
import { ProblemError } from "./problem";
import { Uuid } from "./schemas/common";

/**
 * The prelude every org route repeats: resolve the org from the path's UUID,
 * then the caller (session cookie or bearer token) within it, then hold a
 * token to the scopes the operation's contract names. Throws problems (400 for
 * an id that isn't a UUID, 404, 401, then 403) for the route's catch to answer.
 *
 * Routes call it FIRST, with the raw path param, and validate the rest of the
 * request (other path ids, query, body) after: a caller who can't authenticate,
 * or whose token can't use this operation, gets a 401 or 403, never a 400 that
 * describes what a valid request would look like.
 */
export async function orgContext(orgId: string, contract: Pick<RouteContract, "scopes">) {
  if (!Uuid.safeParse(orgId).success) throw new ProblemError(400, "invalid_request", "orgId must be a UUID");
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new ProblemError(404, "not_found", "Organization not found");
  const ctx = await getAuthContext(org.slug);
  if (!ctx) throw new ProblemError(401, "unauthorized");
  assertScopes(ctx, contract);
  return { org, ctx };
}

/**
 * A bearer token must hold every scope the contract names (implications
 * included: a write scope covers `read`). A browser session has no scopes and
 * is not checked here: it carries the user's full permissions, as always.
 *
 * Refused with the RFC 6750 step-up challenge, so a client can ask its user
 * for a token that covers what it was missing.
 */
export function assertScopes(ctx: AuthContext, contract: Pick<RouteContract, "scopes">) {
  // A browser session holds its user's own permissions and has no scopes.
  if (!ctx.isApiKey) return;
  // A key context always carries its scopes (apiKeyAuthContext). One without
  // them, or an operation that names none, is refused rather than waved through.
  if (!ctx.scopes || contract.scopes.length === 0) {
    throw new ProblemError(403, "insufficient_scope", "This operation is not available to API keys");
  }
  const held = effectiveScopes(ctx.scopes);
  const missing = contract.scopes.filter((s) => !held.has(s));
  if (missing.length === 0) return;
  const wanted = [...new Set([...ctx.scopes, ...contract.scopes])].join(" ");
  throw new ProblemError(
    403,
    "insufficient_scope",
    `This token lacks the ${missing.join(", ")} scope${missing.length > 1 ? "s" : ""} this operation requires`,
    { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${wanted}"` },
  );
}
