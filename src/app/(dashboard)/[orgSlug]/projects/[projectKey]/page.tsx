import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = {
  params: Promise<{ orgSlug: string; projectKey: string }>;
};

export default async function ProjectPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: projectKey, mode: "insensitive" },
      archived: false,
    },
    include: {
      boards: {
        orderBy: { sortOrder: "asc" },
        take: 1,
        select: { id: true },
      },
    },
  });

  if (!project) notFound();

  if (project.boards.length > 0) {
    redirect(
      `/${orgSlug}/projects/${projectKey}/boards/${project.boards[0].id}`
    );
  }

  // No boards yet - show empty state
  return (
    <PageShell title={project.name} description={project.description ?? undefined} maxWidth="7xl">
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <h2 className="text-lg font-medium mb-1">No boards yet</h2>
          <p className="text-sm text-muted-foreground">
            This project does not have any boards configured.
          </p>
        </div>
      </div>
    </PageShell>
  );
}
