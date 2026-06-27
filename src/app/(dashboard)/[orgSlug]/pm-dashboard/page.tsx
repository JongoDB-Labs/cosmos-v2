import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { PmDashboard } from "@/components/pm-dashboard/pm-dashboard";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Org-level PM Dashboard — the portfolio roll-up. Same surface as the
 * project-scoped tab, but aggregated across every project in the org.
 */
export default async function OrgPmDashboardPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const org = await prisma.organization.findUnique({
    where: { id: ctx.orgId },
    select: { name: true },
  });
  if (!org) notFound();

  const where = { orgId: ctx.orgId };
  const [milestones, kpis, goals, risks, deliverables, blockers] = await Promise.all([
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
    prisma.risk.findMany({
      where: { ...where, status: { not: "CLOSED" } },
      orderBy: { score: "desc" },
      select: { id: true, code: true, title: true, level: true, status: true, score: true, escalate: true },
    }),
    prisma.deliverable.findMany({
      where,
      orderBy: { baselineDue: "asc" },
      select: { id: true, code: true, title: true, status: true, baselineDue: true, clin: true },
    }),
    prisma.blocker.findMany({
      where: { ...where, status: "OPEN" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        code: true,
        title: true,
        type: true,
        status: true,
        whatUnblocks: true,
        escalate: true,
        customerNotified: true,
      },
    }),
  ]);

  return (
    <PmDashboard
      scope={{ kind: "org", orgId: ctx.orgId, orgName: org.name }}
      data={{
        milestones: milestones.map((m) => ({
          id: m.id,
          title: m.title,
          status: m.status,
          dueDate: m.dueDate.toISOString(),
        })),
        kpis,
        goals,
        risks,
        deliverables: deliverables.map((d) => ({
          id: d.id,
          code: d.code,
          title: d.title,
          status: d.status,
          clin: d.clin,
          baselineDue: d.baselineDue ? d.baselineDue.toISOString() : null,
        })),
        blockers,
      }}
    />
  );
}
