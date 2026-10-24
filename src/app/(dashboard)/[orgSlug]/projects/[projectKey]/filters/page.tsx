import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { cqlEnabled } from "@/lib/query/flag";
import { ProjectFilters } from "@/components/work-items/cql/project-filters";

type PageParams = {
  params: Promise<{ orgSlug: string; projectKey: string }>;
};

/**
 * Saved filters shared with this project (query design §10.4). Same
 * Cache-Components shape as the Dependencies tab: dynamic reads live here, the
 * client component owns the data load. The project layout has already
 * refused anyone who can't read the project.
 */
export default async function ProjectFiltersPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const [project, org] = await Promise.all([
    prisma.project.findFirst({
      where: { orgId: ctx.orgId, key: { equals: projectKey, mode: "insensitive" }, archived: false },
      select: { id: true, key: true },
    }),
    prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { settings: true } }),
  ]);
  if (!project || !cqlEnabled(org?.settings)) notFound();

  return <ProjectFilters orgId={ctx.orgId} orgSlug={orgSlug} projectId={project.id} projectKey={project.key} />;
}
