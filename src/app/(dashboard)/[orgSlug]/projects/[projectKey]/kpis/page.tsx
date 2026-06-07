import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { KpisDashboard } from "@/components/kpis/kpis-dashboard";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function KPIsPage({ params }: PageParams) {
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

  return <KpisDashboard orgId={ctx.orgId} projectId={project.id} />;
}
