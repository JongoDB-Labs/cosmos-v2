import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { PmDashboard } from "@/components/pm-dashboard/pm-dashboard";
import { loadMilestonesWithDerived } from "@/lib/pm/schedule";
import { loadKpisWithDerived } from "@/lib/pm/kpi-derive";
import { loadClinsWithBurn } from "@/lib/pm/burn";

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
  const [milestones, kpis, goals, risks, deliverables, blockers, changes, clins] = await Promise.all([
    // Milestone status + completion derive from linked work items (org-wide).
    loadMilestonesWithDerived(ctx.orgId),
    // KPI currentValue derives from execution for auto-source KPIs (org-wide).
    loadKpisWithDerived(ctx.orgId),
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
    prisma.changeRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        code: true,
        title: true,
        type: true,
        status: true,
        costImpact: true,
        scheduleDaysImpact: true,
      },
    }),
    loadClinsWithBurn(ctx.orgId),
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
          baselineDate: m.baselineDate ? m.baselineDate.toISOString() : null,
          completionPercent: m.completionPercent,
        })),
        kpis: kpis.map((k) => ({
          id: k.id,
          name: k.name,
          unit: k.unit,
          targetValue: k.targetValue,
          currentValue: k.currentValue,
          direction: k.direction,
          derived: k.derived,
        })),
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
        changes: changes.map((c) => ({
          id: c.id,
          code: c.code,
          title: c.title,
          type: c.type,
          status: c.status,
          costImpact: c.costImpact != null ? Number(c.costImpact) : null,
          scheduleDaysImpact: c.scheduleDaysImpact,
        })),
        clins: clins.map((c) => ({
          id: c.id,
          code: c.code,
          title: c.title,
          value: c.value,
          burned: c.burned,
          percentConsumed: c.percentConsumed,
        })),
      }}
    />
  );
}
