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
import { Permission, hasPermission } from "@/lib/rbac/permissions";

/**
 * Resolve the set of Project.ids in `orgId` the actor may read work items from.
 * Returns an array (possibly empty). Archived projects are included — the list
 * view can choose to surface or hide them, but scoping shouldn't silently drop
 * them.
 */
export async function getReadableProjectIds(ctx: AuthContext): Promise<string[]> {
  const projects = await prisma.project.findMany({
    where: { orgId: ctx.orgId },
    select: { id: true, teamScopedAccess: true },
  });
  if (projects.length === 0) return [];

  // OWNER break-glass — every project, no policy evaluation needed.
  if (ctx.orgRole === "OWNER") return projects.map((p) => p.id);

  // Org-wide administration keeps access to every project, matching
  // isProjectVisible — a project must not be lockable away from the people who
  // run the org. The org ROLE, not PROJECT_MANAGE: that permission is delegable
  // to an ordinary member by a work role, so keying on it here let a "Project
  // Manager" read work items from every restricted project in the org.
  const adminEverywhere = isOrgAdministrator(ctx.orgRole);

  // Does any rule the actor carries reference ITEM_READ with an in_project
  // predicate? If not, no per-project resolution is needed — fast path.
  const itemReadRules = ctx.abacRules.filter(
    (r) => r.effect === "deny" && r.actions?.includes("ITEM_READ"),
  );
  const needsProjectMembership = itemReadRules.some((r) =>
    r.conditions?.some((c) => "rel" in c && c.rel === "in_project"),
  );

  // Pre-resolve the actor's project memberships once (userId → OrgMember.id →
  // ProjectMember.projectId), only if a relevant policy actually needs it.
  // teamScopedAccess ALSO needs memberships, independently of any policy. This
  // is the leak that shipped: a restricted project the actor was not on still
  // came back here, so the org-wide Issues list, its facets, the activity feed
  // and export all showed its work items — the page layout was gated but this
  // was not. Reported in production on 2.249.7.
  const hasRestricted = projects.some((p) => p.teamScopedAccess);

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

  return projects
    // Team scoping first: it is a visibility question, decided before any
    // policy evaluation, and short-circuits to true for every unrestricted
    // project — which is every project until someone opts one in.
    .filter((p) => !p.teamScopedAccess || adminEverywhere || memberProjectIds.has(p.id))
    .filter((p) =>
      evaluateAccess({
        effectivePermissions: ctx.permissions,
        action: "ITEM_READ",
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
