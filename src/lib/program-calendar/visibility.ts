import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import {
  hiddenProjectIds,
  memberProjectIds,
  isOrgAdministrator,
} from "@/lib/rbac/project-access";

/**
 * Who may see which program-calendar events.
 *
 * The event store is ORG-WIDE, which is right for the data — a programme event
 * routinely spans projects — and wrong as a default for reading. So the rule
 * here inverts the usual one: a member sees an event only if it belongs to a
 * project they are on, or to a project whose manager has opened its calendar
 * to the organization (`eventVisibility = ORG`).
 *
 * This is NOT `visibleProjectRecordsWhere`. That helper answers a different
 * question — "is this project hidden from you" — and its default is OPEN, so
 * using it here would have shown every project's calendar to the whole org the
 * moment the feature was enabled. Both rules apply: a project that is
 * team-scoped or out of an API key's project scope stays hidden regardless of
 * its event visibility, so opening a calendar to the org can never widen
 * access beyond what the project itself allows.
 *
 * An event with NO project is org-level by construction — it was created
 * without one deliberately, and there is no narrower audience it could belong
 * to — so every member of the org sees it.
 */
export async function eventScopeWhere(ctx: AuthContext): Promise<Prisma.ProgramEventWhereInput> {
  const hidden = await hiddenProjectIds(ctx);

  // An org owner or admin already administers every project here; narrowing
  // them to their own memberships would hide the programme from the people
  // accountable for it. They are still bound by `hidden`, which carries the
  // API key's project scope.
  if (isOrgAdministrator(ctx.orgRole)) {
    return hidden.length
      ? { OR: [{ projectId: null }, { projectId: { notIn: hidden } }] }
      : {};
  }

  const [memberOf, orgOpen] = await Promise.all([
    memberProjectIds(ctx),
    prisma.project.findMany({
      where: { orgId: ctx.orgId, eventVisibility: "ORG" },
      select: { id: true },
    }),
  ]);

  const hiddenSet = new Set(hidden);
  const allowed = [...new Set([...memberOf, ...orgOpen.map((p) => p.id)])].filter(
    (id) => !hiddenSet.has(id),
  );

  // `in: []` is valid and matches nothing, which is the correct answer for a
  // member of no projects: they still see the org-level events and nothing else.
  return { OR: [{ projectId: null }, { projectId: { in: allowed } }] };
}

/**
 * May this caller attach an event to this project?
 *
 * The same test as reading it. Writing is not widened to "any project in the
 * org": attaching an event to a project you cannot see would either hide your
 * own event from you or, worse, surface it to that project's members as though
 * it were theirs.
 */
export async function canAttachToProject(ctx: AuthContext, projectId: string): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId: ctx.orgId },
    select: { id: true, eventVisibility: true },
  });
  if (!project) return false;

  const hidden = await hiddenProjectIds(ctx);
  if (hidden.includes(projectId)) return false;
  if (isOrgAdministrator(ctx.orgRole)) return true;
  if (project.eventVisibility === "ORG") return true;

  const memberOf = await memberProjectIds(ctx);
  return memberOf.has(projectId);
}
