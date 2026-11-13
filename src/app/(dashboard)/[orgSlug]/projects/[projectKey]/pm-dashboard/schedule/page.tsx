import { IntervalKind } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canReadProject } from "@/lib/rbac/project-access";
import { canReadInProject } from "@/lib/rbac/require-project-read";
import { redirect, notFound } from "next/navigation";
import { ScheduleTracker } from "@/components/pm-dashboard/schedule-tracker";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function SchedulePage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: { orgId: ctx.orgId, key: { equals: projectKey, mode: "insensitive" }, archived: false },
    select: { id: true },
  });
  if (!project || !(await canReadProject(ctx, project.id))) notFound();

  // Only Program Increments may hold a milestone, and only this project's —
  // the FK cannot express either rule, so the picker is narrowed at the source
  // and re-checked server-side on write (lib/pm/milestone-interval.ts).
  //
  // The picker names this project's timeboxes, which the intervals API gives
  // only with SPRINT_READ on the project; without it the picker is empty.
  const programIncrements = !(await canReadInProject(ctx, project.id, "SPRINT_READ")) ? [] : await prisma.interval.findMany({
    where: {
      orgId: ctx.orgId,
      projectId: project.id,
      intervalKind: IntervalKind.PROGRAM_INCREMENT,
    },
    orderBy: { number: "desc" },
    select: { id: true, number: true, name: true },
  });

  return (
    <ScheduleTracker
      orgId={ctx.orgId}
      projectId={project.id}
      programIncrements={programIncrements}
    />
  );
}
