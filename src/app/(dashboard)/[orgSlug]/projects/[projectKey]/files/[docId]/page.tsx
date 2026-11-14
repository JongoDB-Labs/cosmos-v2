import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canReadProject } from "@/lib/rbac/project-access";
import { redirect, notFound } from "next/navigation";
import { FilesWorkspace } from "@/components/files/files-workspace";
import { escapeLike } from "@/lib/query/like";

type PageParams = {
  params: Promise<{ orgSlug: string; projectKey: string }>;
};

/** Deep-link to a single document (e.g. /…/files/<docId>). The client reads the
 *  selected doc id from the URL. */
export default async function FilesDocPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: escapeLike(projectKey), mode: "insensitive" },
      archived: false,
    },
    select: { id: true },
  });

  if (!project || !(await canReadProject(ctx, project.id))) notFound();

  return (
    <FilesWorkspace
      orgId={ctx.orgId}
      projectId={project.id}
      orgSlug={orgSlug}
      projectKey={projectKey}
    />
  );
}
