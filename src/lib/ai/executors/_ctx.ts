import { hasPermission, type PermissionKey } from "@/lib/rbac/permissions";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import type { AuthContext } from "@/lib/rbac/check";
import type { OrgRole } from "@prisma/client";

/**
 * Context handed to every AI tool executor — the org and user the chat is
 * running on behalf of, and the AuthContext the CALLER actually authenticated
 * with.
 *
 * `auth` is the whole point. The routes that run the agent authenticate with
 * `getAuthContext`, which also accepts API keys, and a key's AuthContext is
 * deliberately NARROWER than its minting user: permissions ∩ the key's scope
 * mask, an optional `projectScope` ceiling, and `isApiKey` (which switches off
 * the OWNER break-glass). These helpers used to throw that away and rebuild the
 * actor from `userId` alone (`loadEffectivePermissions(orgId, userId)`), so a
 * read-only or single-project key could have the assistant create, update and
 * delete across the whole org with its owner's full authority.
 *
 * So every permission decision below is made against `auth` and nothing else.
 * There is no fallback to the user's own permissions: a context without `auth`,
 * or whose `auth` was issued for a different org or user, is refused outright.
 * Server-initiated callers that have no HTTP request must build an AuthContext
 * for the identity they act as and pass it here explicitly — that is a decision
 * a caller has to make on purpose, never one this module makes by default.
 */
export interface ToolContext {
  orgId: string;
  userId: string;
  /** The caller's own AuthContext, exactly as the route received it. */
  auth: AuthContext;
}

/**
 * Result of `loadActorPermissions` — the caller's org role and the permission
 * bitmask it may act with (already narrowed by any API-key scope).
 */
export interface ActorPermissions {
  orgRole: OrgRole;
  permissions: bigint;
}

/**
 * The caller's AuthContext, or `null` when the ToolContext does not carry one
 * that belongs to it.
 *
 * The org/user cross-check is not decoration: `orgId` and `userId` are what the
 * executors scope their queries and stamp their rows with, so an `auth` issued
 * for anyone else would authorise one principal while acting as another. A
 * mismatch is a wiring bug, and a wiring bug in an authorization path must deny.
 *
 * Read at RUNTIME, not trusted from the type: plugin dispatchers, `as` casts
 * and JavaScript callers can all hand over a context the compiler never saw.
 */
function callerAuth(ctx: ToolContext): AuthContext | null {
  const auth = (ctx as Partial<ToolContext> | null | undefined)?.auth;
  if (!auth || typeof auth.permissions !== "bigint") return null;
  if (auth.orgId !== ctx.orgId || auth.userId !== ctx.userId) return null;
  return auth;
}

/**
 * The caller's org role and effective permission bitmask, or `null` when the
 * context carries no usable caller AuthContext — callers treat that as
 * "forbidden, no permissions".
 *
 * IMPORTANT: do not `include`/`select` raw `permissions: true` and ship it
 * through JSON — BigInt isn't serializable. Tool executors only ever read it via
 * `assertPermission`.
 */
export async function loadActorPermissions(
  ctx: ToolContext
): Promise<ActorPermissions | null> {
  const auth = callerAuth(ctx);
  if (!auth) return null;
  return { orgRole: auth.orgRole, permissions: auth.permissions };
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
 * It returns the CALLER's AuthContext — the one `getAuthContext` built for the
 * request — so `projectScope` and `isApiKey` reach `getReadableProjectIds`,
 * `isProjectVisible` and `requireAccess` exactly as they do on the REST routes.
 * Rebuilding it from the user id is the bug this replaced: it produced a context
 * with neither field, i.e. an unrestricted session for whoever minted the key.
 *
 * Returns `null` when the context carries no caller AuthContext — callers treat
 * that as denied.
 */
export async function loadAuthContext(
  ctx: ToolContext,
): Promise<AuthContext | null> {
  return callerAuth(ctx);
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
