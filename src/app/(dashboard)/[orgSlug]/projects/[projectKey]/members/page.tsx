import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { canManageProject } from "@/lib/rbac/scope";
import { ProjectMembersManager } from "@/components/projects/project-members-manager";

type PageParams = {
  params: Promise<{ orgSlug: string; projectKey: string }>;
};

export default async function ProjectMembersPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: projectKey, mode: "insensitive" },
      archived: false,
    },
    select: { id: true, name: true },
  });
  if (!project) notFound();

  // Inheriting check: org admins (PROJECT_MANAGE) or a MANAGER of this project
  // can edit; everyone else sees it read-only.
  const canManage = await canManageProject(ctx, project.id);

  return (
    <ProjectMembersManager
      orgId={ctx.orgId}
      projectId={project.id}
      projectName={project.name}
      canManage={canManage}
    />
  );
}
