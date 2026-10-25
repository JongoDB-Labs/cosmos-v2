import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canAdministerProject } from "@/lib/rbac/require-project-manage";
import { isProjectVisible } from "@/lib/rbac/project-access";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { Skeleton } from "@/components/ui/skeleton";
import { NoPageAccess } from "@/components/ui/no-page-access";
import { AutomationsOverview } from "@/components/automation/automations-overview";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

// unstable_instant stays off project-wide (see (dashboard)/[orgSlug]/page.tsx).

/** Project settings → Automations. Params and auth are read behind the Suspense boundary. */
export default function AutomationsSettingsPage({ params }: PageParams) {
  return (
    <div className="mx-auto max-w-5xl p-8">
      <h2 className="mb-2 text-2xl font-semibold tracking-tight">Automations</h2>
      <p className="mb-8 text-sm text-muted-foreground">
        Rules that act on items for you: when something happens to an item, or on a schedule, and the item matches, they move it, set fields, assign,
        label, comment or notify. Each runs with its owner&apos;s access and through the project&apos;s workflow.
      </p>
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function Content({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  const project = await prisma.project.findFirst({
    where: { orgId: ctx.orgId, key: { equals: projectKey, mode: "insensitive" } },
    select: { id: true },
  });
  if (!project) notFound();
  // The routes' own gate: the project visible to them, and the automation-manage permission or this project's manager.
  const allowed = (await isProjectVisible(ctx, project.id)) && (await canAdministerProject(ctx, project.id, Permission.AUTOMATION_MANAGE));
  if (!allowed) return <NoPageAccess what="this project's automations" />;
  return <AutomationsOverview orgId={ctx.orgId} projectId={project.id} canManageWebhooks={hasPermission(ctx.permissions, Permission.WEBHOOK_MANAGE)} />;
}
