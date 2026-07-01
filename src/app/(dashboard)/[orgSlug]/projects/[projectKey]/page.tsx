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

  // Per-user tab prefs (order / hidden / default) now override the project's
  // baseline. Load the CALLER'S prefs for THIS project so the redirect lands
  // them on THEIR chosen default, honoring THEIR hidden feature tabs. Falls
  // through: user default → user defaultBoardId → project defaultTab →
  // project defaultBoardId → first board → empty state. Never crash on a stale
  // token (disabled feature / deleted board).
  const userPrefs = await prisma.userPreferences.findUnique({
    where: { userId: ctx.userId },
    select: { tabPrefs: true, defaultBoardId: true },
  });
  const allTabPrefs =
    userPrefs?.tabPrefs && typeof userPrefs.tabPrefs === "object" && !Array.isArray(userPrefs.tabPrefs)
      ? (userPrefs.tabPrefs as Record<string, unknown>)
      : {};
  const tp =
    allTabPrefs[project.id] &&
    typeof allTabPrefs[project.id] === "object" &&
    !Array.isArray(allTabPrefs[project.id])
      ? (allTabPrefs[project.id] as Record<string, unknown>)
      : {};

  // Map a feature-tab key to its route segment. Used to honor a feature tab set
  // as the default (e.g. land on PM Dashboard).
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

  // Effective hidden-feature set for the redirect check: the user's own list
  // wins, else the project baseline. A default pointing at a hidden feature is
  // treated as invalid and falls through.
  const hiddenFeatureTabs = Array.isArray(tp.hiddenFeatureTabs)
    ? (tp.hiddenFeatureTabs as string[])
    : Array.isArray(settings.hiddenFeatureTabs)
      ? (settings.hiddenFeatureTabs as string[])
      : [];

  // Try a `defaultTab` token (`board:<id>` | `feature:<key>`). Returns true when
  // it resolved to a redirect (which throws), false when the token is invalid
  // and we should keep falling through.
  const tryDefaultTab = (defaultTab: string | null): void => {
    if (!defaultTab) return;
    if (defaultTab.startsWith("feature:")) {
      const key = defaultTab.slice("feature:".length);
      const route = FEATURE_ROUTES[key];
      if (route && project.enabledFeatures.includes(key) && !hiddenFeatureTabs.includes(key)) {
        redirect(`/${orgSlug}/projects/${projectKey}/${route}`);
      }
    } else if (defaultTab.startsWith("board:")) {
      const boardId = defaultTab.slice("board:".length);
      if (project.boards.some((b) => b.id === boardId)) {
        redirect(`/${orgSlug}/projects/${projectKey}/boards/${boardId}`);
      }
    }
    // Invalid token (disabled feature / deleted board) → caller falls through.
  };

  // 1) The user's OWN default tab (their personal choice wins over everything).
  tryDefaultTab(typeof tp.defaultTab === "string" ? tp.defaultTab : null);

  // 2) The user's legacy per-user defaultBoardId (existing UserPreferences field).
  if (
    typeof userPrefs?.defaultBoardId === "string" &&
    project.boards.some((b) => b.id === userPrefs.defaultBoardId)
  ) {
    redirect(`/${orgSlug}/projects/${projectKey}/boards/${userPrefs.defaultBoardId}`);
  }

  // 3) The project-level default tab (manager baseline).
  tryDefaultTab(typeof settings.defaultTab === "string" ? settings.defaultTab : null);

  if (project.boards.length > 0) {
    // 4) Project-level legacy defaultBoardId, else 5) the first board.
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
