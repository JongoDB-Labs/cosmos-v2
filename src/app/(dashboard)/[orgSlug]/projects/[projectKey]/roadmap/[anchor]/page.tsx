import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { RoadmapWorkspace } from "@/components/roadmap/roadmap-workspace";

type PageParams = {
  params: Promise<{ orgSlug: string; projectKey: string; anchor: string }>;
};

/**
 * Deep-link target for a single roadmap node, e.g. /…/roadmap/r-19. Renders the
 * same workspace with the node pre-selected so work-item descriptions can link
 * straight to a phase/risk/decision. The client reads the anchor from the URL.
 */
export default async function RoadmapNodePage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: projectKey, mode: "insensitive" },
      archived: false,
    },
    select: { id: true },
  });

  if (!project) notFound();

  return (
    <RoadmapWorkspace
      orgId={ctx.orgId}
      projectId={project.id}
      orgSlug={orgSlug}
      projectKey={projectKey}
    />
  );
}
