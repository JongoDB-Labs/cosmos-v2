import { scopeMask } from "@/lib/auth/api-key";
import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission, type PermissionKey } from "@/lib/rbac/permissions";
import { requireAccess } from "@/lib/abac/require-access";
import type { ResourceAttributes } from "@/lib/abac/engine";

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

/**
 * For a route that asks an API key for a different bit than a browser session,
 * because no key scope carries the session's bit (KPIs gate a session on
 * ANALYTICS_READ, which no scope holds, so a key on PROJECT_READ). A session
 * needs `sessionBit`. A key needs `keyBit` within its scopes AND `sessionBit`
 * held by the person who made it.
 *
 * The second half is what the bare substitution (`ctx.isApiKey ? A : B`) left
 * out. It was written when only admins held keys, and admins hold every bit;
 * once any member may make a key, a role holding A but not B (a billing admin:
 * PROJECT_READ, not ANALYTICS_READ) read through a key what its own session is
 * refused. A key must never do more than its creator could in the app.
 *
 * The creator's bits come from `ownerPermissions`. A key context built without
 * them falls back to its own masked bits, which are never wider.
 * key-may.arch.test.ts fails on any substitution not made through here.
 */
export function keyMay(
  ctx: Pick<AuthContext, "isApiKey" | "permissions" | "ownerPermissions">,
  keyBit: PermissionKey,
  sessionBit: PermissionKey,
): boolean {
  if (!ctx.isApiKey) return hasPermission(ctx.permissions, Permission[sessionBit]);
  return (
    hasPermission(ctx.permissions, Permission[keyBit]) &&
    hasPermission(ctx.ownerPermissions ?? ctx.permissions, Permission[sessionBit])
  );
}

/** `keyMay` as a gate: throws ForbiddenError, as `requirePermission` does. */
export function requireKeyMay(
  ctx: Pick<AuthContext, "isApiKey" | "permissions" | "ownerPermissions">,
  keyBit: PermissionKey,
  sessionBit: PermissionKey,
): void {
  if (!keyMay(ctx, keyBit, sessionBit)) throw new ForbiddenError("Missing required permission");
}

/** The bits a route asks of an API key and of a browser session (see `keyMay`). */
export interface KeyOrSessionBits {
  key: PermissionKey;
  session: PermissionKey;
}

/**
 * `keyMay` with the org's access policies, for a resource-aware gate
 * (`requireProjectRead(ctx, projectId, { key, session })`). A session meets
 * `session` under its policies. A key meets `key` under its own, and its
 * creator's bits meet `session` under the same policies: a policy that denies
 * the creator `session` denies their keys too, an owner's included (a key has
 * no break-glass).
 */
export async function requireKeyMayAccess(
  ctx: AuthContext,
  bits: KeyOrSessionBits,
  resource: ResourceAttributes,
): Promise<void> {
  if (!keyMay(ctx, bits.key, bits.session)) throw new ForbiddenError("Access denied by policy");
  if (!ctx.isApiKey) return requireAccess(ctx, bits.session, resource);
  // The creator's session bit, under the rules a KEY meets: `isApiKey` stays
  // set, so an owner's key gets no break-glass here either (as in
  // loadEffectivePermissions' forApiKey). Only the bits change.
  await requireAccess({ ...ctx, permissions: ctx.ownerPermissions ?? ctx.permissions }, bits.session, resource);
  await requireAccess(ctx, bits.key, resource);
}
