import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { TemplateGallery } from "@/components/boards/template-gallery";

type PageParams = {
  params: Promise<{ orgSlug: string; projectKey: string }>;
};

export default async function NewBoardPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: projectKey, mode: "insensitive" },
      archived: false,
    },
    select: { id: true, key: true, enabledFeatures: true },
  });

  if (!project) notFound();

  // Guard create — same authority as the boards POST API (org BOARD_CREATE or a
  // manager of THIS project). A VIEWER/GUEST hitting the URL directly is sent
  // back to the project rather than landing on a gallery that 403s on submit.
  const canCreate =
    hasPermission(ctx.permissions, Permission.BOARD_CREATE) ||
    (await canManageProject(ctx, project.id));
  if (!canCreate) redirect(`/${orgSlug}/projects/${project.key}`);

  return (
    <TemplateGallery
      orgId={ctx.orgId}
      projectId={project.id}
      orgSlug={orgSlug}
      projectKey={project.key}
      enabledFeatures={project.enabledFeatures}
    />
  );
}
