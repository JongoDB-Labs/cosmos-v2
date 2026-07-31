import { prisma } from "@/lib/db/client";
import { type AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";

/**
 * The single decision point for "may this actor READ this project?".
 *
 * Why it exists: the access-control audit found `ProjectMember` was a roster
 * rather than a boundary. 46 routes under projects/[projectId] gated reads on
 * the org-wide bitmask alone, so any org MEMBER read every project and the
 * driving use case — a subcontractor who must see only their own team's work —
 * could not be expressed at all. ABAC could not express it either: its
 * condition language has no negation, so `{rel: "in_project"}` can deny members
 * OF a project but never deny non-members.
 *
 * So the decision lives here, once, where it can be read and tested — rather
 * than being restated in 46 routes, which is 46 chances to get it subtly wrong.
 *
 * ORDER OF CHECKS, and why:
 *
 *   1. The org-wide read bit. Nothing below can grant access without it, so a
 *      VIEWER stripped of PROJECT_READ is refused before any query runs.
 *   2. The project must exist IN THIS ORG. Scoping the lookup by orgId means a
 *      cross-tenant id is indistinguishable from a missing one.
 *   3. `teamScopedAccess === false` → allow. This is the historical posture and
 *      the default for every existing row. **This branch is why the change is
 *      safe to deploy**: nothing narrows until someone opts a project in.
 *   4. OWNER break-glass, mirroring `evaluateAccess`.
 *   5. Org-wide PROJECT_MANAGE inherits downward, mirroring `canManageProject`
 *      — an admin cannot lock themselves out of a project they administer.
 *   6. Otherwise: membership of the project is required.
 *
 * This governs project-level visibility. Narrowing *within* a project (which of
 * a project's boards a given team sees) builds on the Team rows this ships and
 * is deliberately not folded in here.
 */
export async function canReadProject(
  ctx: AuthContext,
  projectId: string,
): Promise<boolean> {
  if (!hasPermission(ctx.permissions, Permission.PROJECT_READ)) return false;
  return isProjectVisible(ctx, projectId);
}

/**
 * Project VISIBILITY alone — deliberately with NO opinion about permission bits.
 *
 * Kept separate from `canReadProject` because the routes that gate on their own
 * action bit (ITEM_READ, BOARD_READ, MILESTONE_READ, …) must not silently
 * acquire a PROJECT_READ requirement on top. GUEST is granted ITEM_READ and NOT
 * PROJECT_READ (permissions.ts:321), so folding the two together would revoke
 * GUEST access to items on every unrestricted project — a behaviour change
 * nobody asked for, wearing the costume of a security fix.
 *
 * Answers only: "is this project one the actor is allowed to see at all?"
 */
export async function isProjectVisible(
  ctx: AuthContext,
  projectId: string,
): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId: ctx.orgId },
    select: { id: true, teamScopedAccess: true },
  });
  // Also covers a cross-tenant id: scoped by orgId, so another org's project is
  // indistinguishable from a missing one.
  if (!project) return false;

  // The default, and the reason existing orgs see no behaviour change.
  if (!project.teamScopedAccess) return true;

  if (ctx.orgRole === "OWNER") return true;
  if (hasPermission(ctx.permissions, Permission.PROJECT_MANAGE)) return true;

  return isProjectMember(ctx, projectId);
}

/**
 * Set form for list views, which cannot ask per project without an N+1.
 *
 * Resolves the actor's memberships ONCE and filters in memory. Unrestricted
 * projects are kept for everyone, so an org that has opted nothing in gets back
 * exactly what it passed in.
 *
 * NOT to be confused with `getReadableProjectIds` in work-items/query/scope.ts,
 * which answers a different question (which projects may this actor read WORK
 * ITEMS from, folding in ABAC ITEM_READ denies) and returns an array. Two
 * similarly-named authorization helpers is how the wrong one gets called, so
 * this one is named for what it gates: project VISIBILITY.
 */
export async function getVisibleProjectIds(
  ctx: AuthContext,
  projectIds: string[],
): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();
  if (!hasPermission(ctx.permissions, Permission.PROJECT_READ)) return new Set();

  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds }, orgId: ctx.orgId },
    select: { id: true, teamScopedAccess: true },
  });

  const unrestricted = projects.filter((p) => !p.teamScopedAccess).map((p) => p.id);
  const restricted = projects.filter((p) => p.teamScopedAccess).map((p) => p.id);

  // Nothing opted in — the common case. Skip the membership query entirely.
  if (restricted.length === 0) return new Set(unrestricted);

  if (ctx.orgRole === "OWNER" || hasPermission(ctx.permissions, Permission.PROJECT_MANAGE)) {
    return new Set([...unrestricted, ...restricted]);
  }

  const memberOf = await memberProjectIds(ctx);
  return new Set([...unrestricted, ...restricted.filter((id) => memberOf.has(id))]);
}

/** ProjectMember.orgMemberId is an OrgMember.id, NOT a User.id. */
async function isProjectMember(ctx: AuthContext, projectId: string): Promise<boolean> {
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } },
    select: { id: true },
  });
  if (!member) return false;
  const pm = await prisma.projectMember.findFirst({
    where: { projectId, orgMemberId: member.id },
    select: { id: true },
  });
  return pm !== null;
}

async function memberProjectIds(ctx: AuthContext): Promise<Set<string>> {
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } },
    select: { id: true },
  });
  if (!member) return new Set();
  const rows = await prisma.projectMember.findMany({
    where: { orgMemberId: member.id },
    select: { projectId: true },
  });
  return new Set(rows.map((r) => r.projectId));
}

/**
 * Visibility for a surface that only knows WHO is asking, not their full
 * AuthContext — the @-mention picker and the AI tools both have orgId + userId
 * and nothing else.
 *
 * Resolves the actor's role and effective permissions itself (via the same
 * loader HTTP routes use, so work-role grants count identically), then applies
 * the ordinary rule. A non-member of the org sees nothing.
 *
 * Exists because those two surfaces leaked: both listed every project in the
 * org by name, so a restricted project stayed discoverable through @-mention
 * search and through asking the assistant to list projects — after the pages
 * and the Issues list had been gated.
 */
export async function visibleProjectIdsForActor(
  orgId: string,
  userId: string,
  projectIds: string[],
): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();

  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds }, orgId },
    select: { id: true, teamScopedAccess: true },
  });
  const unrestricted = projects.filter((p) => !p.teamScopedAccess).map((p) => p.id);
  const restricted = projects.filter((p) => p.teamScopedAccess).map((p) => p.id);

  // Nothing opted in — the common case. No role lookup, no membership query.
  if (restricted.length === 0) return new Set(unrestricted);

  const effective = await loadEffectivePermissions(orgId, userId);
  if (!effective) return new Set(); // not a member of this org at all
  if (
    effective.orgRole === "OWNER" ||
    hasPermission(effective.permissions, Permission.PROJECT_MANAGE)
  ) {
    return new Set([...unrestricted, ...restricted]);
  }

  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { id: true },
  });
  if (!member) return new Set(unrestricted);
  const rows = await prisma.projectMember.findMany({
    where: { orgMemberId: member.id, projectId: { in: restricted } },
    select: { projectId: true },
  });
  const memberOf = new Set(rows.map((r) => r.projectId));
  return new Set([...unrestricted, ...restricted.filter((id) => memberOf.has(id))]);
}
