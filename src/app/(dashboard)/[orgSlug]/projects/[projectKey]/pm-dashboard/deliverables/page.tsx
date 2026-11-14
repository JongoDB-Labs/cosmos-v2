import { IntervalKind } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canReadProject } from "@/lib/rbac/project-access";
import { canReadInProject } from "@/lib/rbac/require-project-read";
import { redirect, notFound } from "next/navigation";
import { DeliverableTracker } from "@/components/pm-dashboard/deliverable-tracker";
import { escapeLike } from "@/lib/query/like";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function DeliverablesPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: { orgId: ctx.orgId, key: { equals: escapeLike(projectKey), mode: "insensitive" }, archived: false },
    select: { id: true },
  });
  if (!project || !(await canReadProject(ctx, project.id))) notFound();

  // A CDRL is planned into a SPRINT, so the picker offers this project's
  // sprints — the mirror of the Schedule tab, which offers Program Increments
  // because a milestone can only sit in one (lib/pm/milestone-interval.ts).
  //
  // Only the PICKER is narrowed to SPRINT. The write path checks org + project
  // (lib/pm/deliverable-scope.ts) and deliberately NOT the kind: unlike a
  // milestone, a CDRL tied to some other timebox is not a contradiction, and an
  // import resolving a sprint by name must not fail on how it was classified.
  //
  // The picker names this project's timeboxes, which the intervals API gives
  // only with SPRINT_READ on the project; without it the picker is empty.
  const sprints = !(await canReadInProject(ctx, project.id, "SPRINT_READ")) ? [] : await prisma.interval.findMany({
    where: {
      orgId: ctx.orgId,
      projectId: project.id,
      intervalKind: IntervalKind.SPRINT,
    },
    orderBy: { number: "desc" },
    select: { id: true, number: true, name: true },
  });

  return <DeliverableTracker orgId={ctx.orgId} projectId={project.id} sprints={sprints} />;
}
