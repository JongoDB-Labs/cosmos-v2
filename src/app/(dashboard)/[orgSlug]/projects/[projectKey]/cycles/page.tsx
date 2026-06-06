import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { CyclesWorkspace } from "@/components/cycles/cycles-workspace";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function CyclesPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: projectKey, mode: "insensitive" },
      archived: false,
    },
    select: { id: true },
  });

  if (!project) notFound();

  // The project layout already owns the page's single <h1> (the project name);
  // CyclesWorkspace renders its own section heading + client-side data.
  return <CyclesWorkspace orgId={ctx.orgId} projectId={project.id} />;
}
