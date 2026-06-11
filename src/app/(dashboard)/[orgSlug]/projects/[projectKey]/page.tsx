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
        select: { id: true },
      },
    },
  });

  if (!project) notFound();

  if (project.boards.length > 0) {
    // Honor a manager-set default board (FR: "Default view" — everyone lands on
    // the board the project lead chose). Falls back to the first board if the
    // default is unset or points at a board that no longer exists.
    const settings = (project.settings as Record<string, unknown> | null) ?? {};
    const defaultBoardId =
      typeof settings.defaultBoardId === "string" ? settings.defaultBoardId : null;
    const target =
      defaultBoardId && project.boards.some((b) => b.id === defaultBoardId)
        ? defaultBoardId
        : project.boards[0].id;
    redirect(`/${orgSlug}/projects/${projectKey}/boards/${target}`);
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
