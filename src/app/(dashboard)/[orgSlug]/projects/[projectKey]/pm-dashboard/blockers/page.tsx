import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { BlockerTracker } from "@/components/pm-dashboard/blocker-tracker";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function BlockersPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: { orgId: ctx.orgId, key: { equals: projectKey, mode: "insensitive" }, archived: false },
    select: { id: true },
  });
  if (!project) notFound();

  const branches = await prisma.programBranch.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, code: true, name: true },
  });

  return <BlockerTracker orgId={ctx.orgId} projectId={project.id} branches={branches} />;
}
