/**
 * Govcon PM-Dashboard demo seed — adds Risks, Deliverables, Blockers, and
 * Change Requests to "Apex Defense Systems" / SENTINEL so the PM Dashboard and
 * its Government / Executive views show realistic content.
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

type RiskSeed = {
  code: string;
  title: string;
  description: string;
  category: string;
  branch: string;
  likelihood: number;
  impact: number;
  owner: string;
  mitigation: string;
  status: "OPEN" | "MITIGATING" | "CLOSED";
  trend: string;
  escalate: boolean;
  targetDate: Date;
};

type DeliverableSeed = {
  code: string;
  title: string;
  clin: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "IN_GOVT_REVIEW" | "ACCEPTED" | "REJECTED";
  baselineDue: Date;
  actualSubmission: Date | null;
  owner: string;
};

type BlockerSeed = {
  code: string;
  title: string;
  description: string;
  type: "INTERNAL" | "EXTERNAL_GOVERNMENT" | "EXTERNAL_VENDOR";
  status: "OPEN" | "RESOLVED";
  whatUnblocks: string;
  owner: string;
  customerNotified: boolean;
  escalate: boolean;
};

type ChangeSeed = {
  code: string;
  title: string;
  description: string;
  type: string;
  status: "SUBMITTED" | "APPROVED" | "REJECTED" | "IMPLEMENTED";
  costImpact: number | null;
  scheduleDaysImpact: number | null;
  modRequired: boolean;
};

async function main() {
  const org = await prisma.organization.findUnique({ where: { slug: SLUG } });
  if (!org) throw new Error(`org "${SLUG}" not found — run demo-defense.ts first`);
  const project = await prisma.project.findFirst({ where: { orgId: org.id, key: PKEY } });
  if (!project) throw new Error(`project "${PKEY}" not found — run demo-defense.ts first`);
  const base = { orgId: org.id, projectId: project.id };

  const risks: RiskSeed[] = [
    { code: "R-001", title: "ATO timeline slip", description: "RMF package submission may slip due to incomplete STIG remediation, blocking the phase gate.", category: "Security", branch: "3.0 Security & Compliance", likelihood: 4, impact: 5, owner: "Security Lead", mitigation: "Accelerate STIG remediation; prioritize ATO-blocking findings.", status: "OPEN", trend: "↑ Increasing", escalate: true, targetDate: d(45) },
    { code: "R-002", title: "C3PAO assessment scheduling delay", description: "Limited C3PAO availability may push the CMMC L2 assessment window.", category: "Schedule", branch: "1.0 Program Mgmt", likelihood: 3, impact: 4, owner: "PM", mitigation: "Hold tentative dates with two C3PAOs.", status: "MITIGATING", trend: "→ Stable", escalate: false, targetDate: d(30) },
    { code: "R-003", title: "Technical debt in legacy ingest module", description: "Legacy ingest path is fragile and slows feature delivery.", category: "Technical", branch: "2.0 Software Development", likelihood: 3, impact: 3, owner: "Tech Lead", mitigation: "Allocate a refactor spike in Increment 2.", status: "OPEN", trend: "→ Stable", escalate: false, targetDate: d(60) },
    { code: "R-004", title: "Key personnel attrition", description: "Loss of cleared staff would impact delivery and ATO continuity.", category: "Resource", branch: "1.0 Program Mgmt", likelihood: 2, impact: 4, owner: "PM", mitigation: "Cross-train; maintain a cleared-candidate pipeline.", status: "OPEN", trend: "↓ Decreasing", escalate: false, targetDate: d(90) },
  ];
  for (const r of risks) {
    const score = computeRiskScore(r.likelihood, r.impact);
    await prisma.risk.upsert({
      where: { orgId_code: { orgId: org.id, code: r.code } },
      update: {},
      create: { ...base, ...r, score, level: riskLevelFromScore(score) },
    });
  }

  const deliverables: DeliverableSeed[] = [
    { code: "CDRL-A001", title: "System Security Plan (SSP)", clin: "0001", status: "IN_GOVT_REVIEW", baselineDue: d(-12), actualSubmission: d(-10), owner: "Security Lead" },
    { code: "CDRL-A002", title: "Plan of Action & Milestones (POA&M)", clin: "0001", status: "SUBMITTED", baselineDue: d(-5), actualSubmission: d(-4), owner: "Security Lead" },
    { code: "CDRL-A003", title: "Architecture Design Document", clin: "0002", status: "ACCEPTED", baselineDue: d(-25), actualSubmission: d(-22), owner: "Tech Lead" },
    { code: "CDRL-A004", title: "Monthly Status Report — current period", clin: "0003", status: "NOT_STARTED", baselineDue: d(8), actualSubmission: null, owner: "PM" },
  ];
  for (const x of deliverables) {
    await prisma.deliverable.upsert({
      where: { orgId_code: { orgId: org.id, code: x.code } },
      update: {},
      create: { ...base, ...x },
    });
  }

  const blockers: BlockerSeed[] = [
    { code: "BL-001", title: "GFE server delivery delayed", description: "Government-furnished equipment shipment is delayed, blocking the staging environment.", type: "EXTERNAL_GOVERNMENT", status: "OPEN", whatUnblocks: "Government expedites GFE shipment or authorizes an interim cloud env.", owner: "PM", customerNotified: true, escalate: true },
    { code: "BL-002", title: "Awaiting ATO authorization decision", description: "Deployment cannot proceed until the AO issues the authorization decision.", type: "EXTERNAL_GOVERNMENT", status: "OPEN", whatUnblocks: "AO issues ATO or interim authorization.", owner: "Security Lead", customerNotified: true, escalate: true },
    { code: "BL-003", title: "API schema decision pending (internal)", description: "Increment 2 integration is blocked on an internal API schema decision.", type: "INTERNAL", status: "OPEN", whatUnblocks: "Tech lead finalizes the v2 API schema.", owner: "Tech Lead", customerNotified: false, escalate: false },
  ];
  for (const b of blockers) {
    await prisma.blocker.upsert({
      where: { orgId_code: { orgId: org.id, code: b.code } },
      update: {},
      create: { ...base, ...b },
    });
  }

  const changes: ChangeSeed[] = [
    { code: "CR-001", title: "Add CMMC L2 scope to Increment 2", description: "Expand Increment 2 to include CMMC Level 2 controls per customer direction.", type: "Scope", status: "APPROVED", costImpact: 45000, scheduleDaysImpact: 14, modRequired: true },
    { code: "CR-002", title: "Adjust delivery cadence to monthly", description: "Move from bi-weekly to monthly formal deliveries to align with MSR cycle.", type: "Schedule", status: "SUBMITTED", costImpact: 0, scheduleDaysImpact: 0, modRequired: false },
  ];
  for (const c of changes) {
    await prisma.changeRequest.upsert({
      where: { orgId_code: { orgId: org.id, code: c.code } },
      update: {},
      create: { ...base, ...c },
    });
  }

  console.log(
    `Govcon PM seed: ${risks.length} risks, ${deliverables.length} deliverables, ` +
      `${blockers.length} blockers, ${changes.length} change requests upserted for ${PKEY}.`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
