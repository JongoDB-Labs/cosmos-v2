import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { hiddenProjectIds } from "@/lib/rbac/project-access";
import { ProgramCalendar } from "@/components/program-calendar/program-calendar";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

/**
 * The program calendar, as a PM Dashboard sub-tab.
 *
 * The surface is project-level because that is where the rest of the program
 * tooling lives, but the events are ORG-scoped on purpose: a fleet engagement
 * or a sundown milestone routinely spans several projects, and filing it under
 * one of them would force a false choice and hide it from the others. So the
 * calendar shows everything the reader may see, and `projectId` on an event is
 * an optional link rather than its home.
 */
export default async function ProgramCalendarPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: { orgId: ctx.orgId, key: { equals: projectKey, mode: "insensitive" }, archived: false },
    select: { id: true },
  });
  if (!project) notFound();

  const hidden = await hiddenProjectIds(ctx);

  // Owner lanes: teams first, then people. Both, because a real program assigns
  // an event to a function ("Contracts", "PM Team") as readily as to a person.
  const [teams, members, deliverables] = await Promise.all([
    prisma.team.findMany({
      // Narrowed by project visibility for the same reason deliverables are: a
      // team belongs to a project, so a team on a project this reader cannot
      // open must not be named in the owner picker.
      where: { orgId: ctx.orgId, ...(hidden.length ? { projectId: { notIn: hidden } } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.orgMember.findMany({
      where: { orgId: ctx.orgId, removedAt: null },
      select: { id: true, user: { select: { displayName: true } } },
      orderBy: { joinedAt: "asc" },
    }),
    prisma.deliverable.findMany({
      // `hiddenProjectIds` rather than `visibleProjectRecordsWhere`: that
      // helper's first arm is `{ projectId: null }`, for records that may be
      // org-level. `Deliverable.projectId` is NOT nullable, so that arm does
      // not apply here.
      where: { orgId: ctx.orgId, ...(hidden.length ? { projectId: { notIn: hidden } } : {}) },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
      take: 500,
    }),
  ]);

  const owners = [
    ...teams.map((t) => ({ key: `team:${t.id}`, label: t.name })),
    ...members.map((m) => ({ key: `member:${m.id}`, label: m.user.displayName })),
  ];

  return (
    <div className="p-4">
      <ProgramCalendar
        orgId={ctx.orgId}
        canCreate={hasPermission(ctx.permissions, Permission.BOARD_UPDATE)}
        owners={owners}
        deliverables={deliverables.map((d) => ({ id: d.id, name: d.title }))}
      />
    </div>
  );
}
