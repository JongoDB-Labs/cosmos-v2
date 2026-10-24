import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canAdministerProject } from "@/lib/rbac/require-project-manage";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkflowsOverview } from "@/components/workflow/workflows-overview";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

// unstable_instant stays off project-wide (see (dashboard)/[orgSlug]/page.tsx).

/** Project settings → Workflows. Params and auth are read behind the Suspense boundary. */
export default function WorkflowsSettingsPage({ params }: PageParams) {
  return (
    <div className="mx-auto max-w-5xl p-8">
      <h2 className="mb-2 text-2xl font-semibold tracking-tight">Workflows</h2>
      <p className="mb-8 text-sm text-muted-foreground">
        The statuses each type of item uses, and the moves between them: who may make them, what they ask for and check, and what they do.
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
    select: { id: true, key: true },
  });
  if (!project) notFound();
  const canManage = await canAdministerProject(ctx, project.id, Permission.WORKFLOW_MANAGE);
  return (
    <WorkflowsOverview
      orgId={ctx.orgId}
      orgSlug={orgSlug}
      projectId={project.id}
      projectKey={project.key}
      canManage={canManage}
      canManageTemplates={hasPermission(ctx.permissions, Permission.WORKFLOW_MANAGE)}
    />
  );
}
