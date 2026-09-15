import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { DeliverableTracker } from "@/components/pm-dashboard/deliverable-tracker";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function DeliverablesPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: { orgId: ctx.orgId, key: { equals: projectKey, mode: "insensitive" }, archived: false },
    select: { id: true },
  });
  if (!project) notFound();


  return <DeliverableTracker orgId={ctx.orgId} projectId={project.id} />;
}
