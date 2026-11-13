/**
 * RBAC project-scoping for the cross-project work-item query.
 *
 * The where-builder is pure; this is the ONE DB-backed seam. It answers: "which
 * of this org's projects may the actor read work items from?" — folding in any
 * ABAC `in_project` deny policy exactly the way `requireAccess` would, but
 * resolved once for the whole project set instead of per-row.
 *
 * Contract:
 *   - The caller has ALREADY checked the org-level ITEM_READ bit (via
 *     requireAccess) before listing — this narrows WITHIN that grant.
 *   - OWNER sees every project (break-glass, mirrors evaluateAccess).
 *   - For a non-owner, a project is allowed iff `evaluateAccess` returns true
 *     for ITEM_READ with `in_project` resolved from the actor's project
 *     memberships. With no policies (the common case) this is every project.
 */
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { isOrgAdministrator } from "@/lib/rbac/project-access";
import { evaluateAccess } from "@/lib/abac/engine";
import { Permission, hasPermission, type PermissionKey } from "@/lib/rbac/permissions";

/**
 * Resolve the set of Project.ids in `orgId` the actor may read work items from.
 * Returns an array (possibly empty). Archived projects are included — the list
 * view can choose to surface or hide them, but scoping shouldn't silently drop
 * them.
 *
 * `action` is what the caller is about to read in those projects. Work items by
 * default; a page that rolls up another register across projects (risks, goals)
 * passes that register's action, so a rule that denies it on one project drops
 * that project exactly as the register's own API would refuse it.
 */
export async function getReadableProjectIds(
  ctx: AuthContext,
  action: PermissionKey = "ITEM_READ",
): Promise<string[]> {
  const projects = await prisma.project.findMany({
    where: { orgId: ctx.orgId },
    select: { id: true, teamScopedAccess: true },
  });
  if (projects.length === 0) return [];

  // A project-scoped API key's ceiling, applied BEFORE the role short-circuits
  // below — otherwise an OWNER's key would return every project and the scope
  // would be decorative. Narrowing only: a project named here that the actor
  // cannot read is still dropped by the checks further down.
  const scoped = ctx.projectScope
    ? projects.filter((p) => ctx.projectScope!.includes(p.id))
    : projects;
  if (scoped.length === 0) return [];

  // The action's own bit, before any role shortcut. For a key that is its
  // scopes: an owner's key without this action reads none of its projects,
  // exactly as evaluateAccess would refuse it on each one.
  const bit = Permission[action];
  if (bit === undefined || !hasPermission(ctx.permissions, bit)) return [];

  // OWNER break-glass — every project in scope, no policy evaluation needed.
  // A person only: a key is held to its scopes and rules below, as in
  // evaluateAccess, rather than inheriting the break-glass of whoever minted it.
  if (ctx.orgRole === "OWNER" && !ctx.isApiKey) return scoped.map((p) => p.id);

  // Org-wide administration keeps access to every project, matching
  // isProjectVisible — a project must not be lockable away from the people who
  // run the org. The org ROLE, not PROJECT_MANAGE: that permission is delegable
  // to an ordinary member by a work role, so keying on it here let a "Project
  // Manager" read work items from every restricted project in the org.
  const adminEverywhere = isOrgAdministrator(ctx.orgRole);

  // Does any rule the actor carries reference this action with an in_project
  // predicate? If not, no per-project resolution is needed — fast path.
  const actionRules = ctx.abacRules.filter(
    (r) => r.effect === "deny" && r.actions?.includes(action),
  );
  const needsProjectMembership = actionRules.some((r) =>
    r.conditions?.some((c) => "rel" in c && c.rel === "in_project"),
  );

  // Pre-resolve the actor's project memberships once (userId → OrgMember.id →
  // ProjectMember.projectId), only if a relevant policy actually needs it.
  // teamScopedAccess ALSO needs memberships, independently of any policy. This
  // is the leak that shipped: a restricted project the actor was not on still
  // came back here, so the org-wide Issues list, its facets, the activity feed
  // and export all showed its work items — the page layout was gated but this
  // was not. Reported in production on 2.249.7.
  const hasRestricted = scoped.some((p) => p.teamScopedAccess);

  let memberProjectIds = new Set<string>();
  if (needsProjectMembership || (hasRestricted && !adminEverywhere)) {
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } },
      select: { id: true },
    });
    if (member) {
      const pms = await prisma.projectMember.findMany({
        where: { orgMemberId: member.id },
        select: { projectId: true },
      });
      memberProjectIds = new Set(pms.map((pm) => pm.projectId));
    }
  }

  return scoped
    // Team scoping first: it is a visibility question, decided before any
    // policy evaluation, and short-circuits to true for every unrestricted
    // project — which is every project until someone opts one in.
    .filter((p) => !p.teamScopedAccess || adminEverywhere || memberProjectIds.has(p.id))
    .filter((p) =>
      evaluateAccess({
        effectivePermissions: ctx.permissions,
        action,
        isOwner: false,
        actorUserId: ctx.userId,
        resource: { projectId: p.id, orgId: ctx.orgId },
        relationships: needsProjectMembership
          ? { in_project: memberProjectIds.has(p.id) }
          : undefined,
        rules: ctx.abacRules,
      }),
    )
    .map((p) => p.id);
}

/**
 * Of `projectIds`, the ones where a deny rule the caller carries refuses `action`.
 *
 * Deny rules only: not the action's bit, not team scoping. For a grant that
 * stands on its own, such as a file shared with somebody by name, which opens
 * the file whatever their role or team but must still yield to a rule that
 * says this person may not read that project. With no rules (the common case)
 * this answers without touching the database.
 */
export async function projectsDenyingAction(
  ctx: AuthContext,
  action: PermissionKey,
  projectIds: readonly string[],
): Promise<Set<string>> {
  const denies = ctx.abacRules.filter((r) => r.effect === "deny" && r.actions?.includes(action));
  if (denies.length === 0 || projectIds.length === 0) return new Set();
  const needsMembership = denies.some((r) => r.conditions?.some((c) => "rel" in c && c.rel === "in_project"));
  let memberOf = new Set<string>();
  if (needsMembership) {
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } },
      select: { id: true },
    });
    if (member) {
      const pms = await prisma.projectMember.findMany({ where: { orgMemberId: member.id }, select: { projectId: true } });
      memberOf = new Set(pms.map((pm) => pm.projectId));
    }
  }
  const bit = Permission[action];
  return new Set(
    projectIds.filter(
      (projectId) =>
        !evaluateAccess({
          // The bit is granted here on purpose: this asks only what the rules say.
          effectivePermissions: bit,
          action,
          isOwner: ctx.orgRole === "OWNER",
          isApiKey: ctx.isApiKey,
          actorUserId: ctx.userId,
          resource: { projectId, orgId: ctx.orgId },
          relationships: needsMembership ? { in_project: memberOf.has(projectId) } : undefined,
          rules: denies,
        }),
    ),
  );
}
