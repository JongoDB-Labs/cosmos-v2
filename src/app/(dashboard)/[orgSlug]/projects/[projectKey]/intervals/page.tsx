import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canReadProject } from "@/lib/rbac/project-access";
import { redirect, notFound } from "next/navigation";
import { IntervalsWorkspace } from "@/components/intervals/intervals-workspace";
import { escapeLike } from "@/lib/query/like";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function IntervalsPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: escapeLike(projectKey), mode: "insensitive" },
      archived: false,
    },
    select: { id: true, key: true, projectTemplate: { select: { sector: true } } },
  });

  if (!project || !(await canReadProject(ctx, project.id))) notFound();

  // The project's sector picks the DEFAULT interval kind for the create form;
  // every kind stays available in the picker. Label is always "Intervals".
  const SECTOR_DEFAULT_KIND: Record<string, string> = {
    software: "SPRINT",
    aec: "PHASE",
    consulting: "PHASE",
    education: "MODULE",
    manufacturing: "RUN",
    event: "EVENT_DAY",
    ops: "RELEASE",
  };
  const defaultKind = SECTOR_DEFAULT_KIND[project.projectTemplate?.sector ?? ""] ?? "SPRINT";

  // The project layout already owns the page's single <h1> (the project name);
  // IntervalsWorkspace renders its own section heading + client-side data.
  return (
    <IntervalsWorkspace
      orgId={ctx.orgId}
      projectId={project.id}
      projectKey={project.key}
      defaultKind={defaultKind}
      // Lets capacity planning open on the team this person LEADS rather than
      // on every member of the project.
      viewerUserId={ctx.userId}
    />
  );
}
