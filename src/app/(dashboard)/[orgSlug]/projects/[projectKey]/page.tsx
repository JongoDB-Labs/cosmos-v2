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

  const settings = (project.settings as Record<string, unknown> | null) ?? {};

  // Map a feature-tab key to its route segment. Used to honor a feature tab set
  // as the project default (e.g. land everyone on PM Dashboard).
  const FEATURE_ROUTES: Record<string, string> = {
    "pm-dashboard": "pm-dashboard",
    okr: "okrs",
    goal: "goals",
    kpi: "kpis",
    milestone: "milestones",
    roadmap: "roadmap",
    files: "files",
    cycle: "cycles",
  };

  const hiddenFeatureTabs = Array.isArray(settings.hiddenFeatureTabs)
    ? (settings.hiddenFeatureTabs as string[])
    : [];

  // Honor a manager-set default tab (FR: "Default view" — everyone lands on the
  // board/feature the project lead chose). `defaultTab` is a token
  // (`board:<id>` | `feature:<key>`); fall back to the legacy `defaultBoardId`,
  // then the first board, then the empty state. A default pointing at a
  // now-disabled/hidden feature (or a deleted board) is treated as invalid and
  // falls through — never crash.
  const defaultTab = typeof settings.defaultTab === "string" ? settings.defaultTab : null;
  if (defaultTab) {
    if (defaultTab.startsWith("feature:")) {
      const key = defaultTab.slice("feature:".length);
      const route = FEATURE_ROUTES[key];
      if (
        route &&
        project.enabledFeatures.includes(key) &&
        !hiddenFeatureTabs.includes(key)
      ) {
        redirect(`/${orgSlug}/projects/${projectKey}/${route}`);
      }
    } else if (defaultTab.startsWith("board:")) {
      const boardId = defaultTab.slice("board:".length);
      if (project.boards.some((b) => b.id === boardId)) {
        redirect(`/${orgSlug}/projects/${projectKey}/boards/${boardId}`);
      }
    }
    // Otherwise: invalid token (disabled feature / deleted board) → fall through.
  }

  if (project.boards.length > 0) {
    // Falls back to the legacy defaultBoardId, else the first board.
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
