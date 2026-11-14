import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canReadProject } from "@/lib/rbac/project-access";
import { redirect, notFound } from "next/navigation";
import { DependencyMap } from "@/components/boards/dependencies/dependency-map";
import { escapeLike } from "@/lib/query/like";

type PageParams = {
  params: Promise<{ orgSlug: string; projectKey: string }>;
};

/**
 * Project Dependency Map (FR a36d8f16). A layered-DAG view of the project's
 * work-item dependency links (WorkItemLink), with blocked/blocker/interval
 * summaries.
 */
export default async function DependenciesPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: escapeLike(projectKey), mode: "insensitive" },
      archived: false,
    },
    select: { id: true, key: true },
  });

  if (!project || !(await canReadProject(ctx, project.id))) notFound();

  return (
    <DependencyMap orgId={ctx.orgId} projectId={project.id} projectKey={project.key} />
  );
}
