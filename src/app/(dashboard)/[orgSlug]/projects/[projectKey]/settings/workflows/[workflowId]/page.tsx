import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canAdministerProject } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkflowEditor } from "@/components/workflow/workflow-editor";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string; workflowId: string }> };

// unstable_instant stays off project-wide (see (dashboard)/[orgSlug]/page.tsx).

/** One workflow's editor. Params and auth are read behind the Suspense boundary. */
export default function WorkflowEditorPage({ params }: PageParams) {
  return (
    <div className="mx-auto max-w-6xl p-8">
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function Content({ params }: PageParams) {
  const { orgSlug, projectKey, workflowId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(workflowId)) notFound();
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  const project = await prisma.project.findFirst({
    where: { orgId: ctx.orgId, key: { equals: projectKey, mode: "insensitive" } },
    select: { id: true, key: true },
  });
  if (!project) notFound();
  const workflow = await prisma.workflow.findFirst({ where: { id: workflowId, projectId: project.id }, select: { id: true } });
  if (!workflow) notFound();
  return (
    <WorkflowEditor
      orgId={ctx.orgId}
      orgSlug={orgSlug}
      projectId={project.id}
      projectKey={project.key}
      workflowId={workflow.id}
      canManage={await canAdministerProject(ctx, project.id, Permission.WORKFLOW_MANAGE)}
    />
  );
}
