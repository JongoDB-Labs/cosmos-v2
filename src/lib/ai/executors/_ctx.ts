import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { hasPermission } from "@/lib/rbac/permissions";
import type { OrgRole } from "@prisma/client";

/**
 * Context handed to every AI tool executor — the org and user the chat is
 * running on behalf of.
 */
export interface ToolContext {
  orgId: string;
  userId: string;
}

/**
 * Result of `loadActorPermissions` — the OrgMember row resolved to its
 * effective permission bitmask (role base | stored overrides).
 */
export interface ActorPermissions {
  orgRole: OrgRole;
  permissions: bigint;
}

/**
 * Look up the actor's OrgMember row and return their effective permission
 * bitmask. Returns `null` if the user isn't a member of the org — callers
 * should treat that as "forbidden, no permissions".
 *
 * IMPORTANT: do not `include`/`select` raw `permissions: true` and ship it
 * through JSON — BigInt isn't serializable. We resolve to a bigint here and
 * keep it server-side; tool executors only ever read it via `assertPermission`.
 */
export async function loadActorPermissions(
  ctx: ToolContext
): Promise<ActorPermissions | null> {
  // Shared resolver so AI tools respect work-role grants identically to HTTP
  // routes (the work-role OR lives in exactly one place).
  const effective = await loadEffectivePermissions(ctx.orgId, ctx.userId);
  if (!effective) return null;
  return {
    orgRole: effective.orgRole,
    permissions: effective.permissions,
  };
}

/**
 * Permission gate for tool executors. Returns `null` on success or an
 * `{error}` object that the executor should return verbatim — keeps the
 * pattern uniform across every tool.
 */
export async function assertPermission(
  ctx: ToolContext,
  required: bigint
): Promise<{ error: string } | null> {
  const actor = await loadActorPermissions(ctx);
  if (!actor) return { error: "Insufficient permissions" };
  if (!hasPermission(actor.permissions, required)) {
    return { error: "Insufficient permissions" };
  }
  return null;
}

/**
 * Same as `assertPermission` but for a small set of required permissions
 * (all-of). Returns `{error}` if any are missing.
 */
export async function assertAllPermissions(
  ctx: ToolContext,
  required: bigint[]
): Promise<{ error: string } | null> {
  const actor = await loadActorPermissions(ctx);
  if (!actor) return { error: "Insufficient permissions" };
  for (const p of required) {
    if (!hasPermission(actor.permissions, p)) {
      return { error: "Insufficient permissions" };
    }
  }
  return null;
}
