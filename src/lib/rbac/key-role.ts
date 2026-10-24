import { scopeMask } from "@/lib/auth/api-key";
import type { AuthContext } from "@/lib/rbac/check";
import { hasPermission } from "@/lib/rbac/permissions";

/**
 * Does the actor's ROLE count toward `bit`?
 *
 * Roles grant powers no bit check sees: an org OWNER/ADMIN or a project
 * MANAGER/LEAD may administer a project, moderate comments, manage boards,
 * channels and other people's saved filters. An API key carries the role of
 * whoever minted it, so without this a `read` or `rules:run` key minted by an
 * admin or a project manager could do all of that: its scope mask, which caps
 * every bit check, never got a say.
 *
 * A browser session's role always counts. An API key's counts only when the
 * key's own scopes would grant `bit`. Pass the bit closest to what the role
 * would allow; where no scope grants it, a key never acts by role.
 */
export function roleCountsFor(ctx: Pick<AuthContext, "isApiKey" | "scopes">, bit: bigint): boolean {
  return !ctx.isApiKey || hasPermission(scopeMask(ctx.scopes ?? []), bit);
}

