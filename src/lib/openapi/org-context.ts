import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { effectiveScopes } from "@/lib/auth/api-key-scopes";
import type { AuthContext } from "@/lib/rbac/check";
import type { RouteContract } from "./contract";
import { ProblemError } from "./problem";
import { API_VERSION, apiVersionRefusal } from "./version";

/**
 * The prelude every org route repeats: resolve the org from the path's UUID,
 * then the caller (session cookie or bearer token) within it, then hold a
 * token to the scopes the operation's contract names. Throws problems (404,
 * 401, 403) for the route's catch to answer.
 *
 * `apiVersion` is the version this request runs at (AuthContext.apiVersion).
 */
export async function orgContext(orgId: string, contract: Pick<RouteContract, "scopes">) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new ProblemError(404, "not_found", "Organization not found");
  const ctx = await getAuthContext(org.slug);
  if (!ctx) throw new ProblemError(401, "unauthorized");
  assertScopes(ctx, contract);
  const apiVersion = servableApiVersion(ctx.apiVersion ?? API_VERSION);
  return { org, ctx, apiVersion };
}

/**
 * `v`, or a problem if it can't be served. The proxy has already refused a
 * header naming a bad version; what can still be retired here is a token's
 * PIN, which only the database knows.
 */
export function servableApiVersion(v: string): string {
  const refusal = apiVersionRefusal(v);
  if (refusal) throw new ProblemError(refusal.status, "unsupported_api_version", refusal.detail);
  return v;
}

/**
 * A bearer token must hold every scope the contract names (implications
 * included: a write scope covers `read`). A browser session has no scopes and
 * is not checked here: it carries the user's full permissions, as always.
 *
 * Refused with the RFC 6750 step-up challenge, so a client can ask its user
 * for a token that covers what it was missing.
 */
export function assertScopes(ctx: Pick<AuthContext, "scopes">, contract: Pick<RouteContract, "scopes">) {
  if (!ctx.scopes) return;
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
