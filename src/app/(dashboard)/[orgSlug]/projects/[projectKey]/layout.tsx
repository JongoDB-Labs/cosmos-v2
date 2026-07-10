import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Settings, Upload } from "lucide-react";
import { ProjectBoardTabs } from "./board-tabs";
import { ClassificationBanner } from "@/components/security/classification-banner";

type LayoutParams = {
  params: Promise<{ orgSlug: string; projectKey: string }>;
  children: React.ReactNode;
};

export default async function ProjectLayout({
  params,
  children,
}: LayoutParams) {
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
        select: { id: true, name: true, type: true, slug: true },
      },
      projectTemplate: {
        select: { defaultConfig: true },
      },
    },
  });

  if (!project) notFound();

  // Board create/delete inherit like everything else: an org grant holder OR a
  // manager of THIS project. Computed server-side and passed to the tabs so a
  // project manager without org-wide grants can still manage boards — and,
  // conversely, a VIEWER/GUEST (no grant, not a manager) doesn't see the create
  // affordance at all (the POST would 403 anyway). One manager check, reused.
  const isProjectManager = await canManageProject(ctx, project.id);
  const canManageBoards =
    hasPermission(ctx.permissions, Permission.BOARD_DELETE) || isProjectManager;
  const canCreateBoards =
    hasPermission(ctx.permissions, Permission.BOARD_CREATE) || isProjectManager;
  // Who may set the PROJECT-WIDE default view (the tab everyone without a
  // personal override lands on). Mirrors the PUT …/projects/[projectId] gate
  // exactly: an org-wide PROJECT_UPDATE holder OR a MANAGER of this project.
  const canSetProjectDefault =
    hasPermission(ctx.permissions, Permission.PROJECT_UPDATE) || isProjectManager;

  // Per-user tab tailoring. Order / hidden / default / feature-labels are now
  // PER USER (each member tailors their own strip). The effective value for
  // each key is `user tabPrefs ?? Project.settings ?? natural default`, so a
  // manager's legacy Project.settings still seeds what a brand-new user sees,
  // and the user's own PUTs to …/tab-prefs override it. A board's NAME stays
  // shared (it's the board row) — only the view is personal.
  const userPrefs = await prisma.userPreferences.findUnique({
    where: { userId: ctx.userId },
    select: { tabPrefs: true },
  });
  const projectSettings = (project.settings as Record<string, unknown> | null) ?? {};
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

  // Coercers that fall through user → project → default with the same defensive
  // shape-guards the props already relied on.
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? (v as string[]) : undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const strMap = (v: unknown): Record<string, string> | undefined =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, string>)
      : undefined;

  const defaultTab = str(tp.defaultTab) ?? str(projectSettings.defaultTab) ?? null;
  const tabOrder = strArr(tp.tabOrder) ?? strArr(projectSettings.tabOrder) ?? [];
  const featureTabLabels =
    strMap(tp.featureTabLabels) ?? strMap(projectSettings.featureTabLabels) ?? {};
  const hiddenBoardIds =
    strArr(tp.hiddenBoardIds) ?? strArr(projectSettings.hiddenBoardIds) ?? [];
  const hiddenFeatureTabs =
    strArr(tp.hiddenFeatureTabs) ?? strArr(projectSettings.hiddenFeatureTabs) ?? [];
  // defaultBoardId stays a project-level baseline (legacy back-compat token).
  const defaultBoardId = str(projectSettings.defaultBoardId) ?? null;
  // The PROJECT-WIDE default token (manager baseline) on its own — NOT the
  // user-override blend above. Lets the tabs mark which tab is already the team
  // default so the "Set as default for everyone" action can hide on it.
  const projectDefaultTab = str(projectSettings.defaultTab) ?? null;

  return (
    <div className="flex flex-col h-full">
      {/* Data-classification marking strip (FOUO+); renders nothing otherwise. */}
      <ClassificationBanner orgId={ctx.orgId} projectId={project.id} />

      {/* Project header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
            {project.key}
          </span>
          <h1 className="text-lg font-semibold">{project.name}</h1>
        </div>
        <div className="flex items-center gap-1">
          <Link
            href={`/${orgSlug}/projects/${projectKey}/import`}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}
          >
            <Upload className="h-4 w-4" />
            Import
          </Link>
          <Link
            href={`/${orgSlug}/projects/${projectKey}/settings`}
            aria-label="Project settings"
            className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
          >
            <Settings className="h-4 w-4" />
          </Link>
        </div>
      </div>

      {/* Board tabs */}
      <ProjectBoardTabs
        orgSlug={orgSlug}
        projectKey={projectKey}
        orgId={ctx.orgId}
        projectId={project.id}
        boards={project.boards}
        enabledFeatures={project.enabledFeatures}
        canManageBoards={canManageBoards}
        canCreateBoards={canCreateBoards}
        canSetProjectDefault={canSetProjectDefault}
        defaultBoardId={defaultBoardId}
        defaultTab={defaultTab}
        projectDefaultTab={projectDefaultTab}
        tabOrder={tabOrder}
        featureTabLabels={featureTabLabels}
        hiddenBoardIds={hiddenBoardIds}
        hiddenFeatureTabs={hiddenFeatureTabs}
        templateDefaultConfig={
          project.projectTemplate?.defaultConfig as Record<string, unknown> | null | undefined
        }
      />

      {/* Project content. overflow-y-auto + min-h-0 so CONTENT sub-pages
          (settings, milestones, OKRs, KPIs, goals — plain max-w blocks with no
          inner scroll) can scroll; board/kanban views are h-full and manage
          their OWN internal scroll, so they fill this box exactly and aren't
          affected. overflow-x-hidden keeps wide boards scrolling inside their
          own container, not this one. (Was overflow-hidden, which clipped every
          content sub-page.) */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {children}
      </div>
    </div>
  );
}
