import { Suspense } from "react";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canReadProject } from "@/lib/rbac/project-access";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { hiddenProjectIds } from "@/lib/rbac/project-access";
import { canReadInProject } from "@/lib/rbac/require-project-read";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { NoPageAccess } from "@/components/ui/no-page-access";
import { Skeleton } from "@/components/ui/skeleton";
import { ProgramCalendar } from "@/components/program-calendar/program-calendar";
import { escapeLike } from "@/lib/query/like";

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
/**
 * `params` is handed DOWN as a promise and awaited inside the Suspense child,
 * not awaited here.
 *
 * Cache Components is on, and this page reads cookies (the auth context) and
 * the database. Awaiting at the top does those reads OUTSIDE a boundary, which
 * Next reports as "uncached data during prerendering or a navigation" — this
 * route was the only one in the dev log doing it. See
 * `(dashboard)/[orgSlug]/page.tsx` for the same shape.
 */
export default function ProgramCalendarPage({ params }: PageParams) {
  return (
    <Suspense fallback={<div className="p-4"><Skeleton className="h-[640px] w-full rounded-lg" /></div>}>
      <ProgramCalendarContent params={params} />
    </Suspense>
  );
}

async function ProgramCalendarContent({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: { orgId: ctx.orgId, key: { equals: escapeLike(projectKey), mode: "insensitive" }, archived: false },
    select: { id: true },
  });
  if (!project || !(await canReadProject(ctx, project.id))) notFound();

  // The deliverable picker is the deliverables register rolled up across
  // projects, so it asks what the deliverables API asks: ANALYTICS_READ on this
  // project to open at all, and on each project whose deliverables it names.
  const [mayAnalytics, analyticsProjects, hidden] = await Promise.all([
    canReadInProject(ctx, project.id, "ANALYTICS_READ"),
    getReadableProjectIds(ctx, "ANALYTICS_READ"),
    hiddenProjectIds(ctx),
  ]);
  if (!mayAnalytics) return <NoPageAccess what="this project's program calendar" />;

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
      // The projects readable under ANALYTICS_READ: team scoping, the bit and
      // any rule denying it on a project, as the deliverables API applies them.
      // `Deliverable.projectId` is not nullable, so there is no org-level arm.
      where: { orgId: ctx.orgId, projectId: { in: analyticsProjects } },
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
