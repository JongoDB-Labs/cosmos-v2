import { prisma } from "@/lib/db/client";
import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { type PermissionKey } from "@/lib/rbac/permissions";
import {
  evaluateAccess,
  type AbacRelationship,
  type ResourceAttributes,
} from "./engine";

/**
 * Resource-aware authorization gate. Layers ABAC policy on top of the bitfield:
 * resolves only the DB-backed relationship predicates that the relevant rules
 * actually use, then defers to the pure `evaluateAccess` engine. Throws
 * ForbiddenError on denial (mirrors requirePermission's contract).
 *
 * Behaviour is IDENTICAL to `requirePermission(ctx, Permission[action])` unless
 * a work-role/member policy references `action` — so adopting it on a route is
 * safe even before any org authors a policy.
 */
export async function requireAccess(
  ctx: AuthContext,
  action: PermissionKey,
  resource?: ResourceAttributes,
): Promise<void> {
  const isOwner = ctx.orgRole === "OWNER";

  let relationships: Partial<Record<AbacRelationship, boolean>> | undefined;
  if (!isOwner) {
    const relevant = ctx.abacRules.filter((r) => r.actions?.includes(action));
    // Resolve in_project only if a relevant rule needs it AND we have a project.
    const needsProject = relevant.some((r) =>
      r.conditions?.some((c) => "rel" in c && c.rel === "in_project"),
    );
    if (needsProject && resource?.projectId && UUID_RE.test(resource.projectId)) {
      try {
        relationships = {
          in_project: await isActorInProject(
            ctx.userId,
            ctx.orgId,
            resource.projectId,
          ),
        };
      } catch {
        // Leave in_project UNRESOLVED on error → the engine fails any
        // in_project DENY closed rather than risk a silent bypass.
      }
    }
    // is_manager_of_assignee / same_department have no backing data yet, so they
    // stay unresolved. The engine fails an unresolvable DENY closed (and a v1
    // allow is inert), so an unresolved predicate can never silently bypass a
    // policy. A future policy-authoring endpoint should reject rules using these
    // predicates until the backing columns exist.
  }

  const ok = evaluateAccess({
    effectivePermissions: ctx.permissions,
    action,
    isOwner,
    actorUserId: ctx.userId,
    resource,
    relationships,
    rules: ctx.abacRules,
  });
  if (!ok) throw new ForbiddenError("Access denied by policy");
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** ProjectMember.orgMemberId is an OrgMember.id, NOT a User.id — resolve
 *  userId → OrgMember.id → ProjectMember. (R-1) Missing data → false. The
 *  caller pre-validates the projectId is a UUID and treats a throw as
 *  "unresolved" (deny-safe). */
async function isActorInProject(
  userId: string,
  orgId: string,
  projectId: string,
): Promise<boolean> {
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { id: true },
  });
  if (!member) return false;
  const pm = await prisma.projectMember.findFirst({
    where: { orgMemberId: member.id, projectId },
    select: { orgMemberId: true },
  });
  return pm !== null;
}
