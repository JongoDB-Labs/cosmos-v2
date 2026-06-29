/**
 * Govcon PM-Dashboard demo seed — adds the 6 program branches, plus Risks,
 * Deliverables, Blockers, and Change Requests to "Apex Defense Systems" /
 * SENTINEL so the PM Dashboard and its Government / Executive views show
 * realistic content.
 *
 * SAFE + IDEMPOTENT: upserts on (orgId, code). Run AFTER demo-defense.ts.
 * Run:  npx tsx prisma/seed/demo-defense-pm.ts
 */
import { makePrismaClient } from "./shared/prisma-client";
import { readFileSync } from "node:fs";
import { computeRiskScore, riskLevelFromScore } from "../../src/lib/pm/risk";

function loadEnv(): string | undefined {
  let dbUrl: string | undefined;
  try {
    const txt = readFileSync(process.cwd() + "/.env.local", "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
      if (m[1] === "DATABASE_URL") dbUrl = v;
    }
  } catch {
    /* ignore */
  }
  return dbUrl;
}

const prisma = makePrismaClient(loadEnv());
const SLUG = "apex-defense";
const PKEY = "SENTINEL";

function d(days: number): Date {
  const x = new Date();
  x.setDate(x.getDate() + days);
  return x;
}

const BRANCHES: { code: string; name: string }[] = [
  { code: "1.0", name: "Program Management" },
  { code: "2.0", name: "Software Development" },
  { code: "3.0", name: "Security & Compliance" },
  { code: "4.0", name: "Infra & Environment" },
  { code: "5.0", name: "OT&E" },
  { code: "6.0", name: "Fielding & Transition" },
];

type RiskSeed = {
  code: string; title: string; description: string; category: string; branchCode: string;
  likelihood: number; impact: number; owner: string; mitigation: string;
  status: "OPEN" | "MITIGATING" | "CLOSED"; trend: string; escalate: boolean; targetDate: Date;
};
type DeliverableSeed = {
  code: string; title: string; clin: string; branchCode: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "IN_GOVT_REVIEW" | "ACCEPTED" | "REJECTED";
  baselineDue: Date; actualSubmission: Date | null; owner: string;
};
type BlockerSeed = {
  code: string; title: string; description: string; branchCode: string;
  type: "INTERNAL" | "EXTERNAL_GOVERNMENT" | "EXTERNAL_VENDOR";
  status: "OPEN" | "RESOLVED"; whatUnblocks: string; owner: string;
  customerNotified: boolean; escalate: boolean;
};
type ChangeSeed = {
  code: string; title: string; description: string; type: string; branchCode: string;
  status: "SUBMITTED" | "APPROVED" | "REJECTED" | "IMPLEMENTED";
  costImpact: number | null; scheduleDaysImpact: number | null; modRequired: boolean;
};

async function main() {
  const org = await prisma.organization.findUnique({ where: { slug: SLUG } });
  if (!org) throw new Error(`org "${SLUG}" not found — run demo-defense.ts first`);
  const project = await prisma.project.findFirst({ where: { orgId: org.id, key: PKEY } });
  if (!project) throw new Error(`project "${PKEY}" not found — run demo-defense.ts first`);
  const base = { orgId: org.id, projectId: project.id };

  // Branches first — build a code -> id map for FK wiring.
  const branchId: Record<string, string> = {};
  for (const [i, b] of BRANCHES.entries()) {
    const row = await prisma.programBranch.upsert({
      where: { orgId_code: { orgId: org.id, code: b.code } },
      update: { name: b.name, sortOrder: i },
      create: { orgId: org.id, code: b.code, name: b.name, sortOrder: i },
    });
    branchId[b.code] = row.id;
  }

  const risks: RiskSeed[] = [
    { code: "R-001", title: "ATO timeline slip", description: "RMF package submission may slip due to incomplete STIG remediation, blocking the phase gate.", category: "Security", branchCode: "3.0", likelihood: 4, impact: 5, owner: "Security Lead", mitigation: "Accelerate STIG remediation; prioritize ATO-blocking findings.", status: "OPEN", trend: "↑ Increasing", escalate: true, targetDate: d(45) },
    { code: "R-002", title: "C3PAO assessment scheduling delay", description: "Limited C3PAO availability may push the CMMC L2 assessment window.", category: "Schedule", branchCode: "1.0", likelihood: 3, impact: 4, owner: "PM", mitigation: "Hold tentative dates with two C3PAOs.", status: "MITIGATING", trend: "→ Stable", escalate: false, targetDate: d(30) },
    { code: "R-003", title: "Technical debt in legacy ingest module", description: "Legacy ingest path is fragile and slows feature delivery.", category: "Technical", branchCode: "2.0", likelihood: 3, impact: 3, owner: "Tech Lead", mitigation: "Allocate a refactor spike in Increment 2.", status: "OPEN", trend: "→ Stable", escalate: false, targetDate: d(60) },
    { code: "R-004", title: "Key personnel attrition", description: "Loss of cleared staff would impact delivery and ATO continuity.", category: "Resource", branchCode: "1.0", likelihood: 2, impact: 4, owner: "PM", mitigation: "Cross-train; maintain a cleared-candidate pipeline.", status: "OPEN", trend: "↓ Decreasing", escalate: false, targetDate: d(90) },
  ];
  for (const r of risks) {
    const score = computeRiskScore(r.likelihood, r.impact);
    const branch = BRANCHES.find((b) => b.code === r.branchCode)!;
    await prisma.risk.upsert({
      where: { orgId_code: { orgId: org.id, code: r.code } },
      update: { branchId: branchId[r.branchCode] },
      create: {
        ...base, code: r.code, title: r.title, description: r.description, category: r.category,
        branch: `${branch.code} ${branch.name}`, branchId: branchId[r.branchCode],
        likelihood: r.likelihood, impact: r.impact, score, level: riskLevelFromScore(score),
        owner: r.owner, mitigation: r.mitigation, status: r.status, trend: r.trend,
        escalate: r.escalate, targetDate: r.targetDate,
      },
    });
  }

  const deliverables: DeliverableSeed[] = [
    { code: "CDRL-A001", title: "System Security Plan (SSP)", clin: "0001", branchCode: "3.0", status: "IN_GOVT_REVIEW", baselineDue: d(-12), actualSubmission: d(-10), owner: "Security Lead" },
    { code: "CDRL-A002", title: "Plan of Action & Milestones (POA&M)", clin: "0001", branchCode: "3.0", status: "SUBMITTED", baselineDue: d(-5), actualSubmission: d(-4), owner: "Security Lead" },
    { code: "CDRL-A003", title: "Architecture Design Document", clin: "0002", branchCode: "2.0", status: "ACCEPTED", baselineDue: d(-25), actualSubmission: d(-22), owner: "Tech Lead" },
    { code: "CDRL-A004", title: "Monthly Status Report — current period", clin: "0003", branchCode: "1.0", status: "NOT_STARTED", baselineDue: d(8), actualSubmission: null, owner: "PM" },
  ];
  for (const x of deliverables) {
    await prisma.deliverable.upsert({
      where: { orgId_code: { orgId: org.id, code: x.code } },
      update: { branchId: branchId[x.branchCode] },
      create: { ...base, code: x.code, title: x.title, clin: x.clin, branchId: branchId[x.branchCode], status: x.status, baselineDue: x.baselineDue, actualSubmission: x.actualSubmission, owner: x.owner },
    });
  }

  const blockers: BlockerSeed[] = [
    { code: "BL-001", title: "GFE server delivery delayed", description: "Government-furnished equipment shipment is delayed, blocking the staging environment.", branchCode: "4.0", type: "EXTERNAL_GOVERNMENT", status: "OPEN", whatUnblocks: "Government expedites GFE shipment or authorizes an interim cloud env.", owner: "PM", customerNotified: true, escalate: true },
    { code: "BL-002", title: "Awaiting ATO authorization decision", description: "Deployment cannot proceed until the AO issues the authorization decision.", branchCode: "3.0", type: "EXTERNAL_GOVERNMENT", status: "OPEN", whatUnblocks: "AO issues ATO or interim authorization.", owner: "Security Lead", customerNotified: true, escalate: true },
    { code: "BL-003", title: "API schema decision pending (internal)", description: "Increment 2 integration is blocked on an internal API schema decision.", branchCode: "2.0", type: "INTERNAL", status: "OPEN", whatUnblocks: "Tech lead finalizes the v2 API schema.", owner: "Tech Lead", customerNotified: false, escalate: false },
  ];
  for (const b of blockers) {
    await prisma.blocker.upsert({
      where: { orgId_code: { orgId: org.id, code: b.code } },
      update: { branchId: branchId[b.branchCode] },
      create: { ...base, code: b.code, title: b.title, description: b.description, branchId: branchId[b.branchCode], type: b.type, status: b.status, whatUnblocks: b.whatUnblocks, owner: b.owner, customerNotified: b.customerNotified, escalate: b.escalate },
    });
  }

  const changes: ChangeSeed[] = [
    { code: "CR-001", title: "Add CMMC L2 scope to Increment 2", description: "Expand Increment 2 to include CMMC Level 2 controls per customer direction.", type: "Scope", branchCode: "3.0", status: "APPROVED", costImpact: 45000, scheduleDaysImpact: 14, modRequired: true },
    { code: "CR-002", title: "Adjust delivery cadence to monthly", description: "Move from bi-weekly to monthly formal deliveries to align with MSR cycle.", type: "Schedule", branchCode: "1.0", status: "SUBMITTED", costImpact: 0, scheduleDaysImpact: 0, modRequired: false },
  ];
  for (const c of changes) {
    await prisma.changeRequest.upsert({
      where: { orgId_code: { orgId: org.id, code: c.code } },
      update: { branchId: branchId[c.branchCode] },
      create: { ...base, code: c.code, title: c.title, description: c.description, type: c.type, branchId: branchId[c.branchCode], status: c.status, costImpact: c.costImpact, scheduleDaysImpact: c.scheduleDaysImpact, modRequired: c.modRequired },
    });
  }

  // Schedule-variance backfill: existing milestones get a baseline + projected date
  // so the Schedule tracker's variance column is meaningful. Keyed by title substring.
  const milestoneBaselines: {
    match: string; slipDays: number; rootCause?: string; recoveryPlan?: string;
  }[] = [
    { match: "Increment 1", slipDays: 0 },
    { match: "SSP package", slipDays: 15, rootCause: "STIG remediation backlog delayed SSP finalization.", recoveryPlan: "Surge security staff; submit interim SSP to the C3PAO while closing residual findings." },
    { match: "C3PAO pre-assessment", slipDays: 7, rootCause: "C3PAO availability pushed the review window right.", recoveryPlan: "Hold tentative dates with a second C3PAO to de-risk scheduling." },
    { match: "Increment 2 ATO", slipDays: 0 },
    { match: "CMMC L2 certificate", slipDays: 7 },
  ];
  const milestones = await prisma.milestone.findMany({ where: base });
  let mUpdated = 0;
  for (const m of milestones) {
    const cfg = milestoneBaselines.find((x) => m.title.includes(x.match));
    if (!cfg) continue;
    const baseline = new Date(m.dueDate);
    baseline.setDate(baseline.getDate() - cfg.slipDays);
    await prisma.milestone.update({
      where: { id: m.id },
      data: {
        baselineDate: baseline,
        projectedDate: m.dueDate,
        scheduleEscalate: cfg.slipDays >= 15,
        ...(cfg.rootCause ? { rootCause: cfg.rootCause } : {}),
        ...(cfg.recoveryPlan ? { recoveryPlan: cfg.recoveryPlan } : {}),
      },
    });
    mUpdated++;
  }

  // One revision cycle on the SSP (CDRL-A001) to exercise the DeliverableRevision table.
  let revAdded = 0;
  const ssp = await prisma.deliverable.findFirst({ where: { orgId: org.id, code: "CDRL-A001" } });
  if (ssp) {
    const existing = await prisma.deliverableRevision.findFirst({
      where: { deliverableId: ssp.id, cycle: 1 },
    });
    if (!existing) {
      await prisma.deliverableRevision.create({
        data: {
          orgId: org.id, deliverableId: ssp.id, cycle: 1,
          title: "Gov review — Rev 1 comments",
          dateReturned: d(-6),
          commentSummary: "12 comments: tighten control-inheritance narrative; add an authorization-boundary diagram; clarify FIPS-validated crypto modules.",
          owner: "Security Lead", revisedTarget: d(2),
        },
      });
      revAdded++;
    }
  }

  // Link milestones to work items so the Schedule + dashboard derive status and
  // completion from real execution (the "data trickles up" demo). Idempotent:
  // each seeded milestone's links are cleared + recreated.
  const items = await prisma.workItem.findMany({
    where: base,
    select: { id: true, columnKey: true },
    orderBy: { createdAt: "asc" },
  });
  const inCol = (key: string) => items.filter((w) => w.columnKey === key).map((w) => w.id);
  const done = inCol("done");
  const todo = inCol("todo");
  const backlog = inCol("backlog");
  const wip = [...inCol("in-progress"), ...inCol("review")];

  const linkPlan: { match: string; items: string[] }[] = [
    { match: "Increment 1", items: done.slice(0, 5) }, // all done → COMPLETED
    { match: "SSP package", items: [...done.slice(5, 8), ...todo.slice(0, 2)] }, // past due, mixed → MISSED
    { match: "C3PAO pre-assessment", items: [...wip, ...done.slice(8, 10)] }, // wip present → IN_PROGRESS
    { match: "Increment 2 ATO", items: todo.slice(2, 6) }, // todo only → UPCOMING
    { match: "CMMC L2 certificate", items: backlog.slice(0, 4) }, // backlog only → UPCOMING
  ];
  let linksCreated = 0;
  for (const plan of linkPlan) {
    const m = milestones.find((x) => x.title.includes(plan.match));
    if (!m || plan.items.length === 0) continue;
    await prisma.milestoneLink.deleteMany({ where: { milestoneId: m.id } });
    await prisma.milestoneLink.createMany({
      data: plan.items.map((workItemId) => ({ milestoneId: m.id, workItemId })),
    });
    await prisma.milestone.update({ where: { id: m.id }, data: { autoStatus: true } });
    linksCreated += plan.items.length;
  }

  // KPIs: point a couple at execution so their currentValue trickles up.
  let kpiAuto = 0;
  const velocityKpi = await prisma.kpi.findFirst({ where: { ...base, name: "Sprint velocity" } });
  if (velocityKpi) {
    await prisma.kpi.update({ where: { id: velocityKpi.id }, data: { autoSource: "VELOCITY" } });
    kpiAuto++;
  }
  const completionName = "Work items complete";
  const existingCompletion = await prisma.kpi.findFirst({ where: { ...base, name: completionName } });
  if (!existingCompletion) {
    const last = await prisma.kpi.findFirst({
      where: base,
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    await prisma.kpi.create({
      data: {
        ...base,
        name: completionName,
        unit: "%",
        targetValue: 100,
        currentValue: 0,
        direction: "UP_GOOD",
        autoSource: "COMPLETION_PCT",
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    });
    kpiAuto++;
  }

  // Subcontractors (Partner) + their SENTINEL sub-contracts (Contract, project-scoped).
  const SUBS: {
    name: string; socioEconomic: string; cageCode: string; perfRating: number;
    title: string; value: number; funded: number; invoiced: number;
    agmtType: string; agmtNumber: string; paymentTerms: string;
    nda: boolean; ndaExp: number | null; pocName: string; pocEmail: string;
    status: string; start: number; end: number;
  }[] = [
    { name: "Aegis Cyber Solutions LLC", socioEconomic: "SDVOSB", cageCode: "8F2K1", perfRating: 4, title: "RMF / ATO engineering support", value: 480000, funded: 360000, invoiced: 295000, agmtType: "SUBK", agmtNumber: "SUB-2026-001", paymentTerms: "Net 30", nda: true, ndaExp: 400, pocName: "Rachel Kim", pocEmail: "rachel.kim@aegiscyber.com", status: "active", start: -120, end: 245 },
    { name: "Lumen Data Systems", socioEconomic: "WOSB", cageCode: "7Q9X3", perfRating: 5, title: "Data pipeline & ingest development", value: 320000, funded: 240000, invoiced: 211000, agmtType: "SUBK", agmtNumber: "SUB-2026-002", paymentTerms: "Net 30", nda: true, ndaExp: 210, pocName: "David Osei", pocEmail: "d.osei@lumendata.com", status: "active", start: -90, end: 275 },
    { name: "Harbor Point Analytics", socioEconomic: "8(a)", cageCode: "5R2M8", perfRating: 3, title: "ML threat-scoring models", value: 210000, funded: 120000, invoiced: 64000, agmtType: "MSA", agmtNumber: "MSA-2026-007", paymentTerms: "Net 45", nda: true, ndaExp: 95, pocName: "Lena Park", pocEmail: "lpark@harborpoint.io", status: "signed", start: -30, end: 335 },
    { name: "Ridgeline Integration Inc", socioEconomic: "HUBZone", cageCode: "9T4P2", perfRating: 4, title: "OT&E test harness & range support", value: 150000, funded: 0, invoiced: 0, agmtType: "PO", agmtNumber: "PO-2026-019", paymentTerms: "Net 30", nda: false, ndaExp: null, pocName: "Sam Vance", pocEmail: "svance@ridgeline-inc.com", status: "draft", start: 15, end: 380 },
  ];
  let subsCreated = 0;
  for (const v of SUBS) {
    let partner = await prisma.partner.findFirst({ where: { orgId: org.id, name: v.name } });
    const govcon = {
      socioEconomic: v.socioEconomic, cageCode: v.cageCode, perfRating: v.perfRating, type: "subcontractor",
      ndaOnFile: v.nda, ndaExpiry: v.ndaExp != null ? d(v.ndaExp) : null, pocName: v.pocName, pocEmail: v.pocEmail,
    };
    if (!partner) {
      partner = await prisma.partner.create({ data: { orgId: org.id, name: v.name, status: "active", ...govcon } });
    } else {
      await prisma.partner.update({ where: { id: partner.id }, data: govcon });
    }
    const fin = {
      value: v.value, fundedValue: v.funded, invoicedValue: v.invoiced,
      paymentTerms: v.paymentTerms, agmtType: v.agmtType, agmtNumber: v.agmtNumber,
    };
    const existing = await prisma.contract.findFirst({
      where: { orgId: org.id, projectId: project.id, partnerId: partner.id, title: v.title },
    });
    if (!existing) {
      await prisma.contract.create({
        data: {
          orgId: org.id, projectId: project.id, partnerId: partner.id, title: v.title,
          ...fin, currency: "USD", status: v.status, startDate: d(v.start), endDate: d(v.end),
        },
      });
      subsCreated++;
    } else {
      await prisma.contract.update({ where: { id: existing.id }, data: fin }); // refresh financials on re-seed
    }
  }

  // Staffing — put the org's employees on SENTINEL with roles + allocations so
  // the Team & Staffing lens has a roster (joins to Employee for labor cat /
  // clearance / cost rate).
  const STAFF: { name: string; role: "MANAGER" | "LEAD" | "MEMBER"; allocation: number }[] = [
    { name: "Jon", role: "MANAGER", allocation: 40 },
    { name: "Marcus Hale", role: "LEAD", allocation: 100 },
    { name: "Dana Reyes", role: "MEMBER", allocation: 80 },
    { name: "Priya Nair", role: "MEMBER", allocation: 100 },
    { name: "Tom Becker", role: "MEMBER", allocation: 50 },
  ];
  let staffed = 0;
  for (const s of STAFF) {
    const user = await prisma.user.findFirst({ where: { displayName: s.name } });
    if (!user) continue;
    const om = await prisma.orgMember.findFirst({ where: { orgId: org.id, userId: user.id } });
    if (!om) continue;
    await prisma.projectMember.upsert({
      where: { projectId_orgMemberId: { projectId: project.id, orgMemberId: om.id } },
      update: { role: s.role, allocationPercent: s.allocation },
      create: { projectId: project.id, orgMemberId: om.id, role: s.role, allocationPercent: s.allocation },
    });
    staffed++;
  }

  // CLINs + attributed (approved) time + expenses so the burn rolls up.
  const CLINS: { code: string; title: string; value: number; funded: number; start: number; end: number }[] = [
    { code: "0001", title: "Program Management", value: 850000, funded: 850000, start: -180, end: 185 },
    { code: "0002", title: "Engineering & Development", value: 2400000, funded: 1800000, start: -180, end: 185 },
    { code: "0003", title: "Security & RMF/ATO", value: 620000, funded: 620000, start: -180, end: 185 },
    { code: "0004", title: "OT&E & Fielding", value: 450000, funded: 200000, start: 0, end: 365 },
  ];
  const clinId: Record<string, string> = {};
  for (const c of CLINS) {
    const row = await prisma.clin.upsert({
      where: { orgId_projectId_code: { orgId: org.id, projectId: project.id, code: c.code } },
      update: { title: c.title, value: c.value, fundedValue: c.funded, popStart: d(c.start), popEnd: d(c.end) },
      create: { orgId: org.id, projectId: project.id, code: c.code, title: c.title, value: c.value, fundedValue: c.funded, popStart: d(c.start), popEnd: d(c.end) },
    });
    clinId[c.code] = row.id;
  }
  const uid: Record<string, string> = {};
  for (const name of ["Jon", "Marcus Hale", "Dana Reyes", "Priya Nair", "Tom Becker"]) {
    const u = await prisma.user.findFirst({ where: { displayName: name } });
    if (u) uid[name] = u.id;
  }
  // Idempotent: clear prior attributed time/expense for these CLINs, then re-create.
  const allClinIds = Object.values(clinId);
  await prisma.timeEntry.deleteMany({ where: { orgId: org.id, clinId: { in: allClinIds } } });
  await prisma.expense.deleteMany({ where: { orgId: org.id, clinId: { in: allClinIds } } });
  const TIME: { code: string; name: string; hours: number }[] = [
    { code: "0001", name: "Marcus Hale", hours: 1800 }, { code: "0001", name: "Jon", hours: 400 },
    { code: "0002", name: "Priya Nair", hours: 1600 }, { code: "0002", name: "Marcus Hale", hours: 400 },
    { code: "0003", name: "Dana Reyes", hours: 1700 }, { code: "0003", name: "Tom Becker", hours: 800 },
    { code: "0004", name: "Tom Becker", hours: 300 },
  ];
  for (const t of TIME) {
    if (!uid[t.name]) continue;
    await prisma.timeEntry.create({
      data: { orgId: org.id, userId: uid[t.name], projectId: project.id, clinId: clinId[t.code], date: d(-30), hours: t.hours, status: "APPROVED", billableType: "BILLABLE", description: "Accrued labor (demo)" },
    });
  }
  const EXP: { code: string; amount: number; category: string }[] = [
    { code: "0001", amount: 18000, category: "Travel" }, { code: "0002", amount: 65000, category: "Equipment" },
    { code: "0003", amount: 12000, category: "Training" }, { code: "0004", amount: 8000, category: "Travel" },
  ];
  const createdBy = uid["Jon"] ?? Object.values(uid)[0];
  for (const e of EXP) {
    await prisma.expense.create({
      data: { orgId: org.id, amount: e.amount, currency: "USD", date: d(-20), category: e.category, status: "APPROVED", description: `${e.category} (demo)`, createdById: createdBy, clinId: clinId[e.code] },
    });
  }

  console.log(
    `Govcon PM seed: ${BRANCHES.length} branches, ${risks.length} risks, ${deliverables.length} deliverables, ` +
      `${blockers.length} blockers, ${changes.length} change requests, ${mUpdated} milestone baselines, ` +
      `${revAdded} deliverable revision(s), ${linksCreated} milestone→work-item links, ${kpiAuto} auto KPIs, ` +
      `${subsCreated} subcontracts, ${staffed} staffed, ${CLINS.length} CLINs for ${PKEY}.`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
