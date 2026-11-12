import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canReadProject } from "@/lib/rbac/project-access";
import { canReadInProject } from "@/lib/rbac/require-project-read";
import { NoPageAccess } from "@/components/ui/no-page-access";
import { redirect, notFound } from "next/navigation";
import { PmDashboard } from "@/components/pm-dashboard/pm-dashboard";
import { loadMilestonesWithDerived } from "@/lib/pm/schedule";
import { loadKpisWithDerived } from "@/lib/pm/kpi-derive";
import { loadClinsWithBurn } from "@/lib/pm/burn";
import { loadStaffing, summarizeCompliance } from "@/lib/pm/staffing";
import { canSeeProjectMoney } from "@/lib/rbac/money-fields";

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
  if (!project || !(await canReadProject(ctx, project.id))) notFound();

  // The registers' own API routes gate each one on a bit AND the org's
  // allow/deny rules for this project: ANALYTICS_READ for the registers and
  // KPIs, OKR_READ for goals, PROJECT_READ for milestones. This page reads the
  // same rows directly, so it asks the same questions; otherwise a role without
  // the bit, or a member denied it on this project, read here what the API
  // refuses them.
  const [mayAnalytics, mayGoals, mayMilestones] = await Promise.all([
    canReadInProject(ctx, project.id, "ANALYTICS_READ"),
    canReadInProject(ctx, project.id, "OKR_READ"),
    canReadInProject(ctx, project.id, "PROJECT_READ"),
  ]);
  if (!mayAnalytics) return <NoPageAccess what="this project's PM dashboard" />;

  // Contract money (CLIN figures, a change's cost impact) follows the
  // registers' rule, src/lib/rbac/money-fields.ts -- not the page.
  const money = await canSeeProjectMoney(ctx, project.id);

  const where = { orgId: ctx.orgId, projectId: project.id };
  const [milestones, kpis, goals, risks, deliverables, blockers, changes, clins, staffing] =
    await Promise.all([
    // Milestone status + completion derive from linked work items.
    mayMilestones ? loadMilestonesWithDerived(ctx.orgId, project.id) : [],
    // KPI currentValue derives from execution for auto-source KPIs.
    loadKpisWithDerived(ctx.orgId, project.id),
    mayGoals
      ? prisma.goal.findMany({
          where,
          orderBy: { sortOrder: "asc" },
          select: { id: true, title: true, status: true, progress: true },
        })
      : [],
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
    // Not even queried without it.
    money ? loadClinsWithBurn(ctx.orgId, project.id) : Promise.resolve([]),
    loadStaffing(ctx.orgId, project.id, { includeCost: false }),
  ]);

  const compliance = summarizeCompliance(staffing);

  return (
    <PmDashboard
      moneyWithheld={!money}
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
          actualDate: m.actualDate ? m.actualDate.toISOString() : null,
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
          ...(money ? { costImpact: c.costImpact != null ? Number(c.costImpact) : null } : {}),
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
        compliance,
      }}
    />
  );
}
