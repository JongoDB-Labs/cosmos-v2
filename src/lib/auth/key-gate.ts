import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { assertScopes } from "@/lib/openapi/org-context";
import type { ApiKeyScope } from "./api-key-scopes";

/**
 * What a route that checks no permission bit does with an API key.
 *
 * A key's reach is its minter's permissions narrowed by its scope mask, and
 * the mask only ever bites through a bit check. A handler that checks no bit,
 * because it acts on the caller's own things (their Outlook connection, their
 * preferences, their own feedback), therefore admits a key of ANY scope: a
 * `rules:run` key could cancel its minter's meeting invitations. Each such
 * route must decide, and say so with one of these, right after it
 * authenticates and before it touches anything. The decisions are listed in
 * src/lib/auth/__tests__/bitless-routes.table.ts, which a guard test holds the
 * code to.
 */

/** For a route only a person in a browser should use: 403 for any API key. */
export function refuseApiKey(
  ctx: Pick<AuthContext, "isApiKey">,
  message = "This operation is not available to API keys",
): void {
  if (ctx.isApiKey) throw new ForbiddenError(message);
}

/**
 * For a route with no OpenAPI contract that a key may use: the scopes it must
 * hold, checked exactly as a contract's `x-cosmos-scopes` are (implications
 * included, step-up challenge on refusal). A browser session passes.
 */
export function requireKeyScopes(ctx: AuthContext, scopes: ApiKeyScope[]): void {
  assertScopes(ctx, { scopes });
}

/**
 * For a resource that has no project of its own and so can't be fitted under
 * a project-scoped key's ceiling (a webhook receives every project's events):
 * 403 for a key limited to some projects. An org-wide key and a session pass.
 */
export function refuseProjectScopedKey(ctx: Pick<AuthContext, "projectScope">): void {
  if (ctx.projectScope) {
    throw new ForbiddenError("A key limited to some projects can't use this: it covers the whole organization");
  }
}
