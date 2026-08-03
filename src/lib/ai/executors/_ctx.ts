import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { hasPermission, type PermissionKey } from "@/lib/rbac/permissions";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import type { AuthContext } from "@/lib/rbac/check";
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
 * The actor as a full `AuthContext`, so a tool can reuse the SAME scope helpers
 * the HTTP routes use instead of re-deriving the rule.
 *
 * This exists because re-deriving is exactly how the assistant kept a read rule
 * the API had already fixed. `GET /time-entries` narrows through
 * `readableTimeUserIds` and strips rates via `canSeeRate`; the AI tool gated on
 * a bare TIME_READ — a permission MEMBER and VIEWER both hold — and then
 * queried the whole org with rates selected. Same table, different door.
 *
 * Every field comes from `loadEffectivePermissions`, which is the same source
 * `getAuthContext` builds an HTTP AuthContext from, so the two cannot disagree
 * about what an actor may do. Nothing here is defaulted or invented.
 *
 * Returns `null` when the user is not a member — callers treat that as denied.
 */
export async function loadAuthContext(
  ctx: ToolContext,
): Promise<AuthContext | null> {
  const effective = await loadEffectivePermissions(ctx.orgId, ctx.userId);
  if (!effective) return null;
  return {
    userId: ctx.userId,
    orgId: ctx.orgId,
    orgRole: effective.orgRole,
    permissions: effective.permissions,
    basePermissions: effective.basePermissions,
    abacRules: effective.abacRules,
  };
}

/**
 * May this actor reach this PROJECT at all?
 *
 * `projectInOrg(projectId, orgId)` — what these tools used to ask — answers a
 * different question. It confirms the project EXISTS in the org, which is true
 * of a project the caller may not open. A project with `teamScopedAccess` is
 * restricted to its members, and #513 routed 48 HTTP routes through
 * `requireProjectRead` for exactly that reason; the tools kept the existence
 * check and so read straight past it.
 *
 * The gates the tools carry do not help: ANALYTICS_READ, ITEM_READ, OKR_READ
 * and PROJECT_READ are all held by MEMBER and VIEWER, so they authorise reading
 * SOME project data and say nothing about WHICH project.
 *
 * DELEGATES to `requireProjectRead` rather than re-implementing it — action bit,
 * ABAC policy and team visibility, in the route's own order. Re-deriving the
 * rule is what produced this class of bug twice; a wrapper that forwards cannot
 * drift from what the routes enforce.
 *
 * The error deliberately does not distinguish "not visible" from "does not
 * exist": that is `requireProjectRead`'s own contract, and telling them apart
 * would leak the existence of projects the caller cannot open.
 */
export async function assertProjectRead(
  ctx: ToolContext,
  projectId: string,
  action: PermissionKey,
): Promise<{ error: string } | null> {
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Project not found" };
  try {
    await requireProjectRead(auth, projectId, action);
    return null;
  } catch {
    return { error: "Project not found" };
  }
}

/**
 * May this actor WRITE to this project?
 *
 * `assertProjectRead` is not the right question for a mutation. The HTTP write
 * routes use `requireProjectManage(ctx, projectId, orgWideBit)` — the org-wide
 * permission OR being a manager of that project — and the agent asked something
 * different, which made it wrong in BOTH directions:
 *
 *   - STRICTER for a project manager without the org-wide bit: the app let them
 *     edit their own project's risks; the agent refused.
 *   - LOOSER wherever the agent picked a weaker bit than the route. `create_kpi`
 *     gated on OKR_CREATE, which MEMBER holds, while the KPI routes require
 *     PROJECT_UPDATE, which MEMBER does not — so a member could create KPIs
 *     through the assistant that the app would have refused.
 *
 * FORWARDS to `requireProjectManage`, so it cannot drift from what the routes
 * enforce. Pass the SAME `orgWideBit` the matching route passes; that pairing is
 * the whole contract, and getting it wrong is how the KPI gap appeared.
 */
export async function assertProjectManage(
  ctx: ToolContext,
  projectId: string,
  orgWideBit: bigint,
): Promise<{ error: string } | null> {
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Project not found" };
  // Visibility first: a project you cannot open must read as absent rather than
  // as forbidden, which is `requireProjectRead`'s contract and the reason a
  // refusal cannot be used to discover what exists.
  try {
    await requireProjectRead(auth, projectId, "PROJECT_READ");
  } catch {
    return { error: "Project not found" };
  }
  try {
    await requireProjectManage(auth, projectId, orgWideBit);
    return null;
  } catch {
    return { error: "You do not have permission to change this project" };
  }
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
