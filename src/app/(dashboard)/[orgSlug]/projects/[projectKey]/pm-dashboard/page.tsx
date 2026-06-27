import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { PmDashboard } from "@/components/pm-dashboard/pm-dashboard";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function ProjectPmDashboardPage({ params }: PageParams) {
  const { orgSlug, projectKey } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const project = await prisma.project.findFirst({
    where: {
      orgId: ctx.orgId,
      key: { equals: projectKey, mode: "insensitive" },
      archived: false,
    },
    select: { id: true, key: true, name: true },
  });
  if (!project) notFound();

  const where = { orgId: ctx.orgId, projectId: project.id };
  const [milestones, kpis, goals] = await Promise.all([
    prisma.milestone.findMany({
      where,
      orderBy: { dueDate: "asc" },
      select: { id: true, title: true, status: true, dueDate: true },
    }),
    prisma.kpi.findMany({
      where,
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        unit: true,
        targetValue: true,
        currentValue: true,
        direction: true,
      },
    }),
    prisma.goal.findMany({
      where,
      orderBy: { sortOrder: "asc" },
      select: { id: true, title: true, status: true, progress: true },
    }),
  ]);

  return (
    <PmDashboard
      scope={{
        kind: "project",
        orgId: ctx.orgId,
        projectId: project.id,
        projectKey: project.key,
        projectName: project.name,
      }}
      data={{
        milestones: milestones.map((m) => ({
          id: m.id,
          title: m.title,
          status: m.status,
          dueDate: m.dueDate.toISOString(),
        })),
        kpis,
        goals,
      }}
    />
  );
}
