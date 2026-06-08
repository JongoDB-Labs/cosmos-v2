/**
 * Investor-demo seed (LAYER 3 — "fill every page"): deepens "Apex Defense
 * Systems" so EVERY page in COSMOS v2 has believable, on-theme content — the
 * full accounting suite, invoices/AR, banking, payroll, tax, delivery
 * (goals/milestones/KPIs), analytics, roles, security, integrations, the
 * agent-policy + agent-governance surfaces, feedback, documents, and more.
 *
 * SAFE + IDEMPOTENT: standalone. Run AFTER demo-defense.ts and
 * demo-defense-extra.ts (it relies on the org, users, project, sprints, and
 * partners they create). It seeds its OWN chart of accounts (the earlier seeds
 * do not). Every domain is count-guarded or upserted, so re-running only adds
 * what's missing. Never deletes anything.
 *
 * Loads DATABASE_URL from .env.local itself (nothing secret printed).
 *
 * Run:  cd /home/defcon/cosmos-v2 && npx tsx prisma/seed/demo-defense-fill.ts
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

function loadEnv(): string | undefined {
  let dbUrl: string | undefined;
  try {
    const txt = readFileSync(process.cwd() + "/.env.local", "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
      if (m[1] === "DATABASE_URL") dbUrl = v;
    }
  } catch {
    /* ignore */
  }
  return dbUrl;
}
// Prefer .env.local's DATABASE_URL explicitly so host runs don't fall back to
// .env's in-container `cosmos-postgres` hostname.
const DB_URL = loadEnv();
const prisma = new PrismaClient(DB_URL ? { datasourceUrl: DB_URL } : undefined);

const SLUG = "apex-defense";
const PKEY = "SENTINEL";
const JON_EMAIL = "jon@fightingsmartcyber.com";

const NOW = Date.now();
const day = 86400000;
const d = (days: number) => new Date(NOW + days * day);
const dateOnly = (days: number) => {
  const x = new Date(NOW + days * day);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// digest() is typed Buffer<ArrayBufferLike>, which newer @types/node won't
// assign to Prisma's Bytes fields (Uint8Array<ArrayBuffer>) since ArrayBufferLike
// admits SharedArrayBuffer. The digest is always backed by a plain ArrayBuffer,
// so assert Buffer<ArrayBuffer> — assignable to the Prisma field AND keeps
// Buffer's .toString("hex") for the hash-chain linking.
const shaBytes = (s: string): Buffer<ArrayBuffer> =>
  createHash("sha256").update(s).digest() as Buffer<ArrayBuffer>;

// RBAC permission bits (from src/lib/rbac/permissions.ts) for WorkRole.grants.
// NOTE: work_roles.grants is a Postgres int8 (64-bit), so only bits 0..62 fit.
// We grant from this low-bit subset; the page renders these as permission names.
const P: Record<string, bigint> = {
  ORG_READ: 1n << 0n,
  PROJECT_READ: 1n << 11n,
  PROJECT_MANAGE: 1n << 14n,
  BOARD_READ: 1n << 21n,
  BOARD_UPDATE: 1n << 22n,
  ITEM_CREATE: 1n << 30n,
  ITEM_READ: 1n << 31n,
  ITEM_UPDATE: 1n << 32n,
  ITEM_ASSIGN: 1n << 34n,
  ITEM_BULK_EDIT: 1n << 35n,
  SPRINT_READ: 1n << 41n,
  COMMENT_CREATE: 1n << 50n,
  COMMENT_READ: 1n << 51n,
  OKR_READ: 1n << 56n,
  EXPENSE_APPROVE: 1n << 59n,
  FINANCE_READ: 1n << 60n,
  FINANCE_MANAGE: 1n << 61n,
  CRM_READ: 1n << 62n,
};
const grant = (...keys: string[]) => keys.reduce((acc, k) => acc | (P[k] ?? 0n), 0n);

async function userByEmail(email: string) {
  const u = await prisma.user.findFirst({ where: { email: { equals: email.trim(), mode: "insensitive" } }, select: { id: true } });
  if (!u) throw new Error(`Expected user "${email}" to exist (run demo-defense.ts + demo-defense-extra.ts first).`);
  return u.id;
}

async function main() {
  // ── Resolve prerequisites ─────────────────────────────────────────────────
  const org = await prisma.organization.findUnique({ where: { slug: SLUG }, select: { id: true } });
  if (!org) throw new Error(`Org "${SLUG}" missing — run demo-defense.ts first.`);
  const orgId = org.id;

  const jon = await userByEmail(JON_EMAIL);
  const dana = await userByEmail("dana.reyes@apex-defense.local");
  const marcus = await userByEmail("marcus.hale@apex-defense.local");
  const priya = await userByEmail("priya.nair@apex-defense.local");
  const tom = await userByEmail("tom.becker@apex-defense.local");

  const project = await prisma.project.findFirst({ where: { orgId, key: PKEY }, select: { id: true } });
  if (!project) throw new Error(`Project "${PKEY}" missing — run demo-defense.ts first.`);
  const projectId = project.id;

  const members = await prisma.orgMember.findMany({ where: { orgId }, select: { id: true, userId: true } });
  const memberIdByUser = new Map(members.map((m) => [m.userId, m.id]));

  // Chart of accounts the finance sections below depend on. The app otherwise
  // creates these lazily at finance-runtime (seedSystemCoA in
  // src/lib/ledger/chart-of-accounts.ts); seed them here — inline, matching
  // DEFAULT_COA — so the GL / banking / invoice sections are self-sufficient on
  // a fresh DB instead of throwing "Account <code> not found". Idempotent via
  // skipDuplicates on the orgId_code unique.
  const COA: Array<[string, string, "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE"]> = [
    ["1000", "Cash & Bank", "ASSET"], ["1100", "Accounts Receivable", "ASSET"],
    ["2000", "Accounts Payable", "LIABILITY"], ["2100", "Sales Tax Payable", "LIABILITY"],
    ["2200", "Accrued Payroll", "LIABILITY"], ["3000", "Owner's Equity", "EQUITY"],
    ["3900", "Retained Earnings", "EQUITY"], ["4000", "Sales Revenue", "REVENUE"],
    ["4100", "Service Revenue", "REVENUE"], ["4900", "Other Income", "REVENUE"],
    ["5000", "Cost of Goods Sold", "EXPENSE"], ["6000", "Operating Expenses", "EXPENSE"],
    ["6100", "Labor Expense", "EXPENSE"],
  ];
  await prisma.account.createMany({
    data: COA.map(([code, name, type]) => ({
      orgId, code, name, type,
      normalBalance: (type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT") as "DEBIT" | "CREDIT",
      isSystem: true,
    })),
    skipDuplicates: true,
  });

  const accounts = await prisma.account.findMany({ where: { orgId }, select: { id: true, code: true } });
  const acct = (code: string) => {
    const a = accounts.find((x) => x.code === code);
    if (!a) throw new Error(`Account ${code} not found`);
    return a.id;
  };

  const partners = await prisma.partner.findMany({ where: { orgId }, select: { id: true, name: true } });
  const partnerId = (name: string) => partners.find((p) => p.name.includes(name))?.id ?? null;
  const primeContract = await prisma.contract.findFirst({ where: { orgId, title: { contains: "Prime" } }, select: { id: true } });
  const objectives = await prisma.objective.findMany({ where: { orgId }, select: { id: true, title: true } });
  const wiByTicket = new Map(
    (await prisma.workItem.findMany({ where: { orgId, projectId }, select: { id: true, ticketNumber: true } })).map((w) => [w.ticketNumber, w.id]),
  );

  // ── 0. Re-anchor the active sprint's due dates so the AI brief ALWAYS reads
  //      "~57% complete, ~70% elapsed, 2 overdue (the ATO package + Nessus)" no
  //      matter how long ago the base seed ran. This is an UPDATE (not guarded),
  //      so every `npm run seed:demo` reset restores the engineered state.
  //      Tickets 1–9 are the Sprint-5 items from demo-defense.ts; 4=ATO,
  //      6=Nessus stay overdue; 8=runbook, 9=supply-chain move to the future.
  for (const [ticket, due] of [[4, -2], [6, -1], [8, 2], [9, 5]] as Array<[number, number]>) {
    const id = wiByTicket.get(ticket);
    if (id) await prisma.workItem.update({ where: { id }, data: { dueDate: d(due) } });
  }

  // ── 1. Employees + Pay runs (Payroll page) ────────────────────────────────
  if ((await prisma.employee.count({ where: { orgId } })) === 0) {
    const emps: Array<[string, "SALARY" | "HOURLY", number, string]> = [
      [jon, "SALARY", 165, "Program Director"],
      [dana, "SALARY", 145, "ISSO / Security"],
      [marcus, "SALARY", 138, "Program Manager"],
      [priya, "HOURLY", 152, "Lead Engineer"],
      [tom, "HOURLY", 96, "Compliance Analyst"],
    ];
    for (const [userId, employmentType, costRate, laborCategory] of emps) {
      await prisma.employee.create({
        data: { orgId, userId, employmentType, costRate, laborCategory, classification: laborCategory.includes("Security") ? "Secret" : "None", status: "active", startDate: dateOnly(-400), createdById: jon },
      });
    }
  }
  if ((await prisma.payRun.count({ where: { orgId } })) === 0) {
    for (let m = 3; m >= 1; m--) {
      await prisma.payRun.create({
        data: { orgId, label: `Pay run — month ${4 - m}`, periodStart: dateOnly(-30 * m), periodEnd: dateOnly(-30 * m + 29), status: "POSTED", laborCost: 312_000 + m * 4500, postedAt: d(-30 * m + 31), createdById: jon },
      });
    }
  }

  // ── 2. Tax rates (Tax page) ───────────────────────────────────────────────
  if ((await prisma.taxRate.count({ where: { orgId } })) === 0) {
    await prisma.taxRate.createMany({
      data: [
        { orgId, name: "U.S. Government — Tax Exempt", rate: 0, jurisdiction: "Federal", isDefault: true, isActive: true, createdById: jon },
        { orgId, name: "Virginia State Sales Tax", rate: 0.053, jurisdiction: "VA", isDefault: false, isActive: true, createdById: jon },
        { orgId, name: "Fairfax County Local", rate: 0.01, jurisdiction: "VA-059", isDefault: false, isActive: true, createdById: jon },
      ],
    });
  }

  // ── 3. Invoices + line items + payments (Invoices / AR page) ───────────────
  if ((await prisma.invoice.count({ where: { orgId } })) === 0) {
    const invoices: Array<{ n: string; status: "PAID" | "SENT" | "PARTIAL" | "DRAFT" | "VOID"; issued: number; due: number; clin: string; qty: number; price: number; paid?: number }> = [
      { n: "INV-2026-0001", status: "PAID", issued: -110, due: -80, clin: "CLIN 0001 — Base Year engineering (milestone 1)", qty: 1, price: 1_200_000, paid: 1_200_000 },
      { n: "INV-2026-0002", status: "PAID", issued: -80, due: -50, clin: "CLIN 0001 — Base Year engineering (milestone 2)", qty: 1, price: 1_200_000, paid: 1_200_000 },
      { n: "INV-2026-0003", status: "PARTIAL", issued: -40, due: -10, clin: "CLIN 0002 — Cyber engineering services (Q1)", qty: 1, price: 850_000, paid: 400_000 },
      { n: "INV-2026-0004", status: "SENT", issued: -12, due: 18, clin: "CLIN 0003 — Option Year 1 (partial obligation)", qty: 1, price: 620_000 },
      { n: "INV-2026-0005", status: "DRAFT", issued: -2, due: 28, clin: "CLIN 0002 — Cyber engineering services (Q2)", qty: 1, price: 480_000 },
    ];
    for (const inv of invoices) {
      const subtotal = inv.qty * inv.price;
      await prisma.invoice.create({
        data: {
          orgId, number: inv.n, contractId: primeContract?.id ?? null, billToName: "USAF AFLCMC — Sentinel Program Office", billToEmail: "contracts.sentinel@us.af.mil",
          status: inv.status, issueDate: inv.issued != null ? dateOnly(inv.issued) : null, dueDate: dateOnly(inv.due), currency: "USD",
          subtotal, taxTotal: 0, total: subtotal, amountPaid: inv.paid ?? 0, terms: "Net 30 — payment via Treasury EFT", notes: "CUI per DFARS 252.204-7012. Reference contract FA8750-25-C-0142.",
          createdById: jon,
          lineItems: { create: [{ description: inv.clin, quantity: inv.qty, unitPrice: inv.price, taxRate: 0, amount: subtotal, sortOrder: 0 }] },
          ...(inv.paid ? { payments: { create: [{ orgId, amount: inv.paid, method: "eft", reference: "TREAS-EFT", receivedAt: dateOnly(inv.due - 3), createdById: jon }] } } : {}),
        },
      });
    }
  }

  // ── 4. General ledger: accounting periods + journal entries/lines ──────────
  if ((await prisma.accountingPeriod.count({ where: { orgId } })) === 0) {
    for (let m = 6; m >= 0; m--) {
      const start = new Date(Date.UTC(new Date(NOW).getUTCFullYear(), new Date(NOW).getUTCMonth() - m, 1));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      await prisma.accountingPeriod.create({ data: { orgId, startDate: start, endDate: end, status: m === 0 ? "OPEN" : "CLOSED", closedAt: m === 0 ? null : d(-30 * (m - 1)), closedById: m === 0 ? null : jon } });
    }
  }
  if ((await prisma.journalEntry.count({ where: { orgId } })) === 0) {
    let n = 1001;
    const mkEntry = async (days: number, memo: string, source: "MANUAL" | "REVENUE" | "EXPENSE" | "INVOICE" | "PAYMENT" | "PAYROLL", lines: Array<{ code: string; dir: "DEBIT" | "CREDIT"; amt: number; desc: string }>) => {
      await prisma.journalEntry.create({
        data: {
          orgId, entryNumber: n++, date: dateOnly(days), memo, status: "POSTED", source, postedAt: d(days), createdById: jon,
          lines: { create: lines.map((l, i) => ({ orgId, accountId: acct(l.code), direction: l.dir, amount: l.amt, description: l.desc, sortOrder: i, projectId })) },
        },
      });
    };
    for (let m = 4; m >= 1; m--) {
      await mkEntry(-30 * m, `Revenue recognized — Sentinel (month ${5 - m})`, "REVENUE", [
        { code: "1100", dir: "DEBIT", amt: 720_000, desc: "Accounts Receivable — USAF" },
        { code: "4100", dir: "CREDIT", amt: 720_000, desc: "Service Revenue — Sentinel CLINs" },
      ]);
      await mkEntry(-30 * m + 2, `Direct labor & overhead — month ${5 - m}`, "PAYROLL", [
        { code: "5000", dir: "DEBIT", amt: 318_000, desc: "Direct labor (CPFF)" },
        { code: "6000", dir: "DEBIT", amt: 86_500, desc: "Overhead & G&A" },
        { code: "1000", dir: "CREDIT", amt: 404_500, desc: "Cash disbursed — payroll & opex" },
      ]);
    }
    await mkEntry(-9, "Cash receipt — USAF EFT (INV-2026-0002)", "PAYMENT", [
      { code: "1000", dir: "DEBIT", amt: 1_200_000, desc: "Cash & Bank" },
      { code: "1100", dir: "CREDIT", amt: 1_200_000, desc: "Accounts Receivable — USAF" },
    ]);
    await mkEntry(-6, "Subcontractor accrual — Vector Systems LLC", "EXPENSE", [
      { code: "5000", dir: "DEBIT", amt: 128_400, desc: "Subcontract labor (SUB-0142-001)" },
      { code: "2000", dir: "CREDIT", amt: 128_400, desc: "Accounts Payable — Vector Systems" },
    ]);
  }

  // ── 5. Banking: account + transactions + rules (Banking page) ─────────────
  if ((await prisma.bankAccount.count({ where: { orgId } })) === 0) {
    const txns: Array<{ days: number; amt: number; desc: string; status: "POSTED" | "MATCHED" | "CATEGORIZED" | "IMPORTED"; cat?: string }> = [
      { days: -9, amt: 1_200_000, desc: "TREASURY EFT CREDIT — USAF AFLCMC SENTINEL", status: "MATCHED", cat: "Contract Revenue" },
      { days: -8, amt: -128_400, desc: "ACH DEBIT — VECTOR SYSTEMS LLC SUB-0142", status: "POSTED", cat: "Subcontractor Labor" },
      { days: -7, amt: -18_750, desc: "ACH DEBIT — CLOUDHARBOR GOVCLOUD", status: "POSTED", cat: "Cloud Hosting" },
      { days: -6, amt: -312_540, desc: "PAYROLL RUN — ADP GOV", status: "CATEGORIZED", cat: "Payroll" },
      { days: -5, amt: -2_410, desc: "CARD — GITHUB ENTERPRISE", status: "CATEGORIZED", cat: "Software" },
      { days: -4, amt: -24_000, desc: "WIRE — SENTINEL SCIF HOLDINGS LEASE", status: "POSTED", cat: "Facilities" },
      { days: -3, amt: -42_000, desc: "ACH DEBIT — SECURESCAN INC PENTEST", status: "IMPORTED" },
      { days: -2, amt: 400_000, desc: "TREASURY EFT CREDIT — USAF (INV-0003 partial)", status: "IMPORTED" },
      { days: -1, amt: -1_180, desc: "CARD — ATLASSIAN JIRA", status: "IMPORTED" },
    ];
    await prisma.bankAccount.create({
      data: {
        orgId, name: "Operating Account — First GovBank", institution: "First GovBank, N.A.", mask: "4471", currency: "USD", provider: "MANUAL_IMPORT", ledgerAccountId: acct("1000"), isActive: true, createdById: jon,
        transactions: { create: txns.map((t, i) => ({ orgId, externalId: `FGB-${1000 + i}`, fingerprint: sha(`${t.days}|${t.amt}|${t.desc}`).slice(0, 32), postedDate: dateOnly(t.days), amount: t.amt, description: t.desc, pending: t.status === "IMPORTED" && t.days >= -1, status: t.status, category: t.cat ?? null })) },
      },
    });
    await prisma.bankRule.createMany({
      data: [
        { orgId, name: "GovCloud → Cloud Hosting", descriptionContains: "CLOUDHARBOR", direction: "debit", category: "Cloud Hosting", priority: 10, isActive: true, createdById: jon },
        { orgId, name: "Treasury EFT → Contract Revenue", descriptionContains: "TREASURY EFT", direction: "credit", category: "Contract Revenue", priority: 20, isActive: true, createdById: jon },
        { orgId, name: "ADP → Payroll", descriptionContains: "PAYROLL", direction: "debit", category: "Payroll", priority: 5, isActive: true, createdById: jon },
      ],
    });
  }

  // ── 6. Delivery: Goals + Milestones + KPIs (Goals/Milestones/KPIs pages) ──
  if ((await prisma.goal.count({ where: { orgId, projectId } })) === 0) {
    const goals: Array<{ t: string; desc: string; status: "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "ACHIEVED" | "PLANNED"; prog: number; due: number; owner: string; wi?: number; obj?: string }> = [
      { t: "Achieve CMMC Level 2 certification", desc: "Pass the C3PAO assessment with zero open POA&M CAT I findings.", status: "AT_RISK", prog: 79, due: 45, owner: dana, obj: "CMMC" },
      { t: "Deliver Increment 2 to the warfighter", desc: "Ship Sentinel Increment 2 (ATO'd) to the operational enclave.", status: "ON_TRACK", prog: 57, due: 30, owner: marcus, wi: 4 },
      { t: "Close all CAT I/II STIG findings", desc: "Remediate the RHEL 9 baseline to a clean STIG checklist.", status: "ON_TRACK", prog: 88, due: 14, owner: priya, wi: 2 },
      { t: "Grow the defense backlog to $15M", desc: "Convert the BD pipeline into $15M of obligated/queued backlog.", status: "PLANNED", prog: 41, due: 120, owner: jon },
    ];
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      const links: Array<{ kind: "WORK_ITEM" | "OBJECTIVE"; workItemId?: string; objectiveId?: string }> = [];
      if (g.wi && wiByTicket.get(g.wi)) links.push({ kind: "WORK_ITEM", workItemId: wiByTicket.get(g.wi)! });
      if (g.obj) {
        const o = objectives.find((x) => x.title.toUpperCase().includes(g.obj!));
        if (o) links.push({ kind: "OBJECTIVE", objectiveId: o.id });
      }
      await prisma.goal.create({
        data: { orgId, projectId, title: g.t, description: g.desc, status: g.status, progress: g.prog, progressMode: "MANUAL", targetDate: d(g.due), ownerId: g.owner, sortOrder: i, ...(links.length ? { links: { create: links } } : {}) },
      });
    }
  }
  if ((await prisma.milestone.count({ where: { orgId, projectId } })) === 0) {
    const ms: Array<{ t: string; due: number; status: "COMPLETED" | "IN_PROGRESS" | "UPCOMING" | "MISSED"; owner: string; wi?: number }> = [
      { t: "Increment 1 delivered & ATO'd", due: -90, status: "COMPLETED", owner: marcus },
      { t: "SSP package submitted to C3PAO", due: -2, status: "MISSED", owner: dana, wi: 4 },
      { t: "C3PAO pre-assessment review", due: 7, status: "IN_PROGRESS", owner: dana },
      { t: "Increment 2 ATO granted", due: 30, status: "UPCOMING", owner: marcus },
      { t: "CMMC L2 certificate issued", due: 60, status: "UPCOMING", owner: dana },
    ];
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      await prisma.milestone.create({
        data: { orgId, projectId, title: m.t, dueDate: d(m.due), status: m.status, autoStatus: false, completedAt: m.status === "COMPLETED" ? d(m.due) : null, ownerId: m.owner, sortOrder: i, ...(m.wi && wiByTicket.get(m.wi) ? { links: { create: [{ workItemId: wiByTicket.get(m.wi)! }] } } : {}) },
      });
    }
  }
  if ((await prisma.kpi.count({ where: { orgId, projectId } })) === 0) {
    const kpis: Array<{ n: string; unit: string; target: number; current: number; dir: "UP_GOOD" | "DOWN_GOOD"; pts: number[] }> = [
      { n: "NIST 800-171 controls implemented", unit: "%", target: 100, current: 79, dir: "UP_GOOD", pts: [62, 68, 71, 75, 79] },
      { n: "Sprint velocity", unit: "pts", target: 45, current: 41, dir: "UP_GOOD", pts: [33, 38, 36, 42, 41] },
      { n: "Open CAT II findings (past SLA)", unit: "count", target: 0, current: 3, dir: "DOWN_GOOD", pts: [9, 7, 6, 4, 3] },
      { n: "Mean time to remediate", unit: "days", target: 14, current: 19, dir: "DOWN_GOOD", pts: [31, 27, 24, 21, 19] },
      { n: "Subcontractor utilization", unit: "%", target: 85, current: 81, dir: "UP_GOOD", pts: [72, 74, 78, 80, 81] },
    ];
    for (let i = 0; i < kpis.length; i++) {
      const k = kpis[i];
      await prisma.kpi.create({
        data: { orgId, projectId, name: k.n, unit: k.unit, targetValue: k.target, currentValue: k.current, direction: k.dir, sortOrder: i, dataPoints: { create: k.pts.map((v, j) => ({ value: v, recordedAt: d(-7 * (k.pts.length - j)), note: null })) } },
      });
    }
  }

  // ── 7. Analytics → Saved reports ──────────────────────────────────────────
  if ((await prisma.savedReport.count({ where: { orgId } })) === 0) {
    await prisma.savedReport.createMany({
      data: [
        { orgId, createdById: jon, name: "Sprint Velocity (last 5)", type: "velocity", config: { project: PKEY, sprints: 5 }, lastRunAt: d(-1) },
        { orgId, createdById: dana, name: "NIST 800-171 Control Posture", type: "compliance", config: { framework: "NIST_800_171" }, lastRunAt: d(-2) },
        { orgId, createdById: marcus, name: "Program Burndown — Increment 2", type: "burndown", config: { project: PKEY }, lastRunAt: d(-1) },
        { orgId, createdById: jon, name: "Finance Summary — FY26", type: "finance", config: { period: "FY26" }, schedule: "0 8 * * 1", lastRunAt: d(-3) },
      ],
    });
  }

  // ── 8. Workspace: custom fields, theme, user prefs ────────────────────────
  if ((await prisma.customField.count({ where: { orgId } })) === 0) {
    await prisma.customField.createMany({
      data: [
        { orgId, name: "STIG ID", key: "stig_id", fieldType: "TEXT", options: [], required: false, sortOrder: 0 },
        { orgId, name: "CAT Level", key: "cat_level", fieldType: "SELECT", options: ["CAT I", "CAT II", "CAT III"], required: false, sortOrder: 1 },
        { orgId, name: "Control Family", key: "control_family", fieldType: "SELECT", options: ["AC", "AU", "SC", "SI", "IR", "RA"], required: false, sortOrder: 2 },
        { orgId, name: "Evidence Link", key: "evidence_link", fieldType: "URL", options: [], required: false, sortOrder: 3 },
      ],
    });
  }
  if ((await prisma.theme.count({ where: { orgId } })) === 0) {
    await prisma.theme.create({
      data: { orgId, slug: "apex-defense-dark", name: "Apex Defense (Dark)", mode: "DARK", colors: { primary: "#1f3a5f", accent: "#3b82f6", background: "#0b1220" }, branding: { wordmark: "APEX DEFENSE SYSTEMS" }, isBuiltIn: false, isActive: true },
    });
  }
  await prisma.userPreferences.upsert({
    where: { userId: jon },
    update: {},
    create: { userId: jon, sidebarPosition: "LEFT", navigationStyle: "BOTH", density: "COMFORTABLE", themeMode: "DARK", methodology: "scrum" },
  });

  // ── 9. Roles & Access: work roles + assignments ───────────────────────────
  if ((await prisma.workRole.count({ where: { orgId } })) === 0) {
    const roles: Array<{ key: string; name: string; desc: string; grants: bigint; assign: string }> = [
      { key: "isso", name: "ISSO (Security Lead)", desc: "Information System Security Officer — owns compliance, classification, and security posture.", grants: grant("ORG_READ", "PROJECT_READ", "BOARD_READ", "ITEM_READ", "SPRINT_READ", "COMMENT_READ", "OKR_READ", "FINANCE_READ", "CRM_READ"), assign: dana },
      { key: "program-manager", name: "Program Manager", desc: "Runs the program — schedule, scope, finance visibility, and delivery.", grants: grant("ORG_READ", "PROJECT_READ", "PROJECT_MANAGE", "ITEM_CREATE", "ITEM_READ", "ITEM_UPDATE", "ITEM_ASSIGN", "SPRINT_READ", "OKR_READ", "EXPENSE_APPROVE", "FINANCE_READ", "FINANCE_MANAGE", "CRM_READ"), assign: marcus },
      { key: "lead-engineer", name: "Lead Engineer", desc: "Technical lead — boards, work items, comments, and bulk edits.", grants: grant("ORG_READ", "PROJECT_READ", "BOARD_READ", "BOARD_UPDATE", "ITEM_CREATE", "ITEM_READ", "ITEM_UPDATE", "ITEM_ASSIGN", "ITEM_BULK_EDIT", "SPRINT_READ", "COMMENT_CREATE", "COMMENT_READ"), assign: priya },
      { key: "compliance-analyst", name: "Compliance Analyst", desc: "Read-mostly compliance and audit support.", grants: grant("ORG_READ", "PROJECT_READ", "BOARD_READ", "ITEM_READ", "COMMENT_READ", "OKR_READ", "FINANCE_READ"), assign: tom },
    ];
    for (const r of roles) {
      const wr = await prisma.workRole.create({ data: { orgId, key: r.key, name: r.name, description: r.desc, grants: r.grants, policies: [], isBuiltIn: false } });
      const mid = memberIdByUser.get(r.assign);
      if (mid) await prisma.orgMemberWorkRole.upsert({ where: { orgMemberId_workRoleId: { orgMemberId: mid, workRoleId: wr.id } }, update: {}, create: { orgMemberId: mid, workRoleId: wr.id } });
    }
  }

  // ── 10. Security: IP allowlist, SCIM token, API key ───────────────────────
  if ((await prisma.ipAllowlist.count({ where: { orgId } })) === 0) {
    await prisma.ipAllowlist.createMany({
      data: [
        { orgId, cidr: "198.51.100.0/24", label: "HQ SCIF — Chantilly VA" },
        { orgId, cidr: "203.0.113.0/25", label: "AWS GovCloud egress" },
        { orgId, cidr: "192.0.2.44/32", label: "ISSO remote (CAC VPN)" },
      ],
    });
  }
  if ((await prisma.scimToken.count({ where: { orgId } })) === 0) {
    await prisma.scimToken.create({ data: { orgId, tokenHash: sha("demo-scim-token"), prefix: "scim_apex", label: "Okta SCIM provisioning", lastUsed: d(-1) } });
  }
  if ((await prisma.apiKey.count({ where: { orgId } })) === 0) {
    await prisma.apiKey.create({ data: { orgId, name: "CI/CD pipeline (GitLab Gov)", keyHash: sha("demo-api-key"), prefix: "ak_live_apex", scopes: ["project:read", "item:write"], lastUsed: d(-2) } });
  }

  // ── 11. Integrations, webhooks, MCP servers, AI + runtime config ──────────
  if ((await prisma.integration.count({ where: { orgId } })) === 0) {
    await prisma.integration.createMany({
      data: [
        { orgId, provider: "google", displayName: "Google Workspace (Gmail + Calendar)", status: "ACTIVE", installedById: jon, lastSyncAt: d(-0.2), config: { scopes: ["gmail", "calendar"] } },
        { orgId, provider: "github", displayName: "GitHub — apex-defense/sentinel", status: "ACTIVE", installedById: priya, lastSyncAt: d(-0.5), config: { repo: "apex-defense/sentinel" } },
        { orgId, provider: "jira", displayName: "Jira — SENTINEL", status: "ACTIVE", installedById: marcus, lastSyncAt: d(-1), config: { projectKey: "SENTINEL" } },
        { orgId, provider: "slack", displayName: "Slack — Apex Defense", status: "ACTIVE", installedById: jon, lastSyncAt: d(-0.3), config: { team: "apex-defense" } },
        { orgId, provider: "m365", displayName: "Microsoft 365 (GCC High)", status: "INACTIVE", installedById: jon, config: { cloud: "GCCHigh" } },
      ],
    });
  }
  if ((await prisma.webhook.count({ where: { orgId } })) === 0) {
    await prisma.webhook.create({
      data: {
        orgId, url: "https://soc.apex-defense.example/hooks/cosmos", events: ["compliance.control.failed", "work_item.created", "audit.exported"], secret: "whsec_demo_" + sha("apex").slice(0, 24), active: true,
        deliveries: { create: [
          { event: "compliance.control.failed", payload: { controlId: "3.11.2" }, status: "SUCCESS", statusCode: 200, attempts: 1, lastAttemptAt: d(-3) },
          { event: "work_item.created", payload: { key: "SENTINEL-9" }, status: "SUCCESS", statusCode: 200, attempts: 1, lastAttemptAt: d(-1) },
          { event: "audit.exported", payload: { format: "csv" }, status: "FAILED", statusCode: 503, responseBody: "upstream timeout", attempts: 3, lastAttemptAt: d(-0.5) },
        ] },
      },
    });
  }
  if ((await prisma.mcpServer.count({ where: { orgId } })) === 0) {
    await prisma.mcpServer.createMany({
      data: [
        { orgId, name: "Tenable.sc (vuln management)", transport: "http", url: "https://tenable.apex-defense.example/mcp", enabled: true },
        { orgId, name: "ServiceNow (ITSM)", transport: "http", url: "https://snow.apex-defense.example/mcp", enabled: true },
        { orgId, name: "Splunk ES (SIEM)", transport: "http", url: "https://splunk.apex-defense.example/mcp", enabled: false },
      ],
    });
  }
  await prisma.orgAiSettings.upsert({
    where: { orgId },
    update: {},
    create: { orgId, provider: "anthropic", model: "claude-opus-4-8", updatedById: jon },
  });
  await prisma.orgRuntimeConfig.upsert({
    where: { orgId },
    update: {},
    create: { orgId, allowlistEnabled: true, enabledConnectors: ["google", "github", "jira", "slack"], breadthEnabled: false, mcpEnabled: true },
  });

  // ── 12. Agent Policy (3-axis middle gate) ─────────────────────────────────
  await prisma.agentPolicy.upsert({
    where: { orgId },
    update: {},
    create: { orgId, allowedToolsSet: false, allowedTools: [], deniedTools: ["delete_work_item", "delete_project"], deniedDomains: ["nango"], maxResultLimit: 50, allowedProjectIdsSet: true, allowedProjectIds: [projectId] },
  });

  // ── 13. Agent Governance: egress decisions + handles + chain checkpoint ────
  if ((await prisma.egressDecisionRow.count({})) === 0) {
    const conv = "demo-conv-" + sha(orgId).slice(0, 8);
    const rows: Array<{ turn: number; kind: string; tool: string | null; exposed: boolean; withheld: number; ceiling: string | null }> = [
      { turn: 1, kind: "tool_result", tool: "query_sprint", exposed: true, withheld: 0, ceiling: null },
      { turn: 1, kind: "cui_field", tool: "query_sprint", exposed: false, withheld: 2, ceiling: "CUI" },
      { turn: 2, kind: "tool_result", tool: "create_work_item", exposed: true, withheld: 0, ceiling: null },
      { turn: 3, kind: "cui_field", tool: "query_compliance_controls", exposed: false, withheld: 4, ceiling: "CUI" },
      { turn: 3, kind: "handle_resolve", tool: "update_compliance_control", exposed: true, withheld: 0, ceiling: "CUI" },
      { turn: 4, kind: "tool_result", tool: "send_email", exposed: true, withheld: 0, ceiling: null },
    ];
    for (const r of rows) {
      const contentHash = sha(`${conv}|${r.turn}|${r.kind}|${r.tool}|${r.exposed}|${r.withheld}`);
      // seq + rowHash + prevHash are DB-managed: `seq` is GENERATED ALWAYS AS
      // IDENTITY and row_hash/prev_hash are filled by the BEFORE INSERT
      // hash-chain trigger (see schema.prisma + migration 20260606070000). The
      // client must NOT write them — Postgres rejects an explicit value into a
      // GENERATED ALWAYS identity column, and the trigger overwrites the hashes
      // regardless. Let the DB build the chain.
      await prisma.egressDecisionRow.create({
        data: { conversationId: conv, turn: r.turn, valueKind: r.kind, toolName: r.tool, exposed: r.exposed, withheldCount: r.withheld, contentHash, decidedBy: "egress-gate@v2", tenantClass: "GOV", ceiling: r.ceiling },
      });
    }
    // A couple of minted opaque handles (withheld CUI the agent acted on by reference)
    await prisma.egressHandle.createMany({
      data: [
        { conversationId: conv, token: "h_" + sha("handle1").slice(0, 24), valueEnc: "enc:" + sha("ssp-task-id"), entityType: "work_item", fieldName: "id", ceiling: "CUI" },
        { conversationId: conv, token: "h_" + sha("handle2").slice(0, 24), valueEnc: "enc:" + sha("control-3.11.2"), entityType: "compliance_control", fieldName: "id", ceiling: "CUI" },
      ],
    });
    // Signed chain checkpoints (AU-9/AU-11 tamper-evidence). Read back the
    // trigger-computed head (last row's seq + row_hash) so the checkpoint
    // matches the chain the DB actually stored, rather than a locally-computed
    // hash the trigger would have discarded.
    const head = await prisma.egressDecisionRow.findFirst({
      where: { conversationId: conv },
      orderBy: { seq: "desc" },
      select: { seq: true, rowHash: true },
    });
    if (head?.seq != null && head.rowHash) {
      const headHash = Buffer.from(head.rowHash) as Buffer<ArrayBuffer>;
      await prisma.auditChainCheckpoint.create({ data: { tableName: "egress_decisions", checkpointSeq: head.seq, checkpointRowHash: headHash, sig: shaBytes("sig|egress|" + headHash.toString("hex")) } });
    }
    await prisma.auditChainCheckpoint.create({ data: { tableName: "audit_logs", checkpointSeq: 174n, checkpointRowHash: shaBytes("audit-head"), sig: shaBytes("sig|audit|head") } });
  }

  // ── 14. Documents (project document library) ──────────────────────────────
  if ((await prisma.document.count({ where: { orgId } })) === 0) {
    const docs: Array<[string, string, "CUI" | "UNCLASSIFIED" | "FOUO", string, number]> = [
      ["System Security Plan (SSP) v4.2", "SSP_Sentinel_v4.2.pdf", "CUI", "application/pdf", 2_840_000],
      ["POA&M Tracker — Q2", "POAM_Sentinel_Q2.xlsx", "CUI", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 184_000],
      ["Independent Penetration Test Report", "SecureScan_Pentest_2026.pdf", "CUI", "application/pdf", 5_120_000],
      ["CMMC L2 Assessment Readiness Brief", "C3PAO_Readiness_Brief.pptx", "FOUO", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 3_300_000],
      ["Sentinel Program Org Chart", "Sentinel_Org_Chart.pdf", "UNCLASSIFIED", "application/pdf", 96_000],
    ];
    for (const [title, filename, level, contentType, size] of docs) {
      await prisma.document.create({ data: { orgId, projectId, title, classificationLevel: level, storageKey: `demo/${orgId}/${filename}`, filename, contentType, size, uploadedById: dana } });
    }
  }

  // ── 15. Pending invitations (Team page) ───────────────────────────────────
  if ((await prisma.invitation.count({ where: { orgId } })) === 0) {
    await prisma.invitation.createMany({
      data: [
        { orgId, email: "assessor@c3pao-partner.example", role: "VIEWER", expiresAt: d(14) },
        { orgId, email: "new.engineer@apex-defense.local", role: "MEMBER", expiresAt: d(7) },
      ],
    });
  }

  // ── 16. Notifications (for Jon) ───────────────────────────────────────────
  if ((await prisma.notification.count({ where: { orgId, userId: jon } })) === 0) {
    await prisma.notification.createMany({
      data: [
        { orgId, userId: jon, type: "compliance", title: "Control 3.11.2 marked FAILED", body: "Vulnerability scanning — 3 open CAT II findings past SLA.", refType: "compliance_control", refId: "3.11.2", read: false, url: `/${SLUG}/settings/compliance` },
        { orgId, userId: jon, type: "mention", title: "Dana mentioned you in #security-compliance", body: "Let's get the SSP package over the line.", read: false, url: `/${SLUG}/chat` },
        { orgId, userId: jon, type: "work_item", title: "SENTINEL-4 is overdue", body: "ATO package: update SSP control families AC, AU, SC.", refType: "work_item", read: true },
        { orgId, userId: jon, type: "finance", title: "Invoice INV-2026-0003 partially paid", body: "$400,000 of $850,000 received.", read: true },
      ],
    });
  }

  // ── 17. Feedback board ────────────────────────────────────────────────────
  if ((await prisma.feedbackItem.count({ where: { orgId } })) === 0) {
    const fb: Array<{ t: string; d: string; type: "FEATURE" | "BUG"; status: "OPEN" | "PLANNED" | "IN_PROGRESS" | "DONE" | "DECLINED"; voters: string[] }> = [
      { t: "Continuous (nightly) CMMC control monitoring", d: "Run the control check automatically every night, not just on demand.", type: "FEATURE", status: "PLANNED", voters: [jon, dana, marcus] },
      { t: "Push POA&M items straight to Tenable via MCP", d: "When a control fails, open the remediation ticket in Tenable, not just COSMOS.", type: "FEATURE", status: "IN_PROGRESS", voters: [dana, priya] },
      { t: "Export audit trail as a signed PDF", d: "Assessors want a signed PDF, not just CSV/JSON.", type: "FEATURE", status: "OPEN", voters: [tom, dana] },
      { t: "FedRAMP authorization path", d: "Need the platform itself on the FedRAMP path for broader adoption.", type: "FEATURE", status: "PLANNED", voters: [jon] },
    ];
    for (const f of fb) {
      await prisma.feedbackItem.create({ data: { orgId, authorId: f.voters[0], type: f.type, title: f.t, description: f.d, status: f.status, voteCount: f.voters.length, votes: { create: f.voters.map((u) => ({ userId: u })) } } });
    }
  }

  // ── 18. Work-item dependency links (timeline arrows) + a Timeline board ────
  if ((await prisma.workItemLink.count({ where: { orgId } })) === 0) {
    const link = (s: number, t: number, type: "BLOCKS" | "BLOCKED_BY" | "RELATES" | "PREDECESSOR" | "SUCCESSOR") => {
      const sid = wiByTicket.get(s), tid = wiByTicket.get(t);
      return sid && tid ? { orgId, sourceItemId: sid, targetItemId: tid, type } : null;
    };
    const links = [link(6, 4, "BLOCKS"), link(1, 4, "PREDECESSOR"), link(5, 4, "PREDECESSOR"), link(8, 6, "RELATES"), link(9, 4, "RELATES")].filter(Boolean) as Array<{ orgId: string; sourceItemId: string; targetItemId: string; type: "BLOCKS" | "BLOCKED_BY" | "RELATES" | "PREDECESSOR" | "SUCCESSOR" }>;
    if (links.length) await prisma.workItemLink.createMany({ data: links });
  }
  const hasTimeline = await prisma.board.findFirst({ where: { orgId, projectId, type: "TIMELINE" }, select: { id: true } });
  if (!hasTimeline) {
    const maxSort = await prisma.board.aggregate({ where: { orgId, projectId }, _max: { sortOrder: true } });
    await prisma.board.create({ data: { orgId, projectId, name: "Delivery Timeline", type: "TIMELINE", sortOrder: (maxSort._max.sortOrder ?? 0) + 1 } });
  }

  // ── 19. Work-item attachments (evidence files) ────────────────────────────
  if ((await prisma.workItemAttachment.count({ where: { orgId } })) === 0) {
    const at = (ticket: number, fileName: string, mimeType: string, size: number) => {
      const id = wiByTicket.get(ticket);
      return id ? { orgId, workItemId: id, fileName, url: `demo/${orgId}/wi/${fileName}`, mimeType, sizeBytes: size } : null;
    };
    const atts = [at(1, "FIPS_140-3_validation_cert.pdf", "application/pdf", 410_000), at(2, "STIG_checklist_RHEL9.ckl", "application/xml", 88_000), at(4, "SSP_AC_AU_SC_families.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 1_200_000), at(6, "Nessus_Q2_scan.nessus", "application/xml", 2_600_000)].filter(Boolean) as Array<{ orgId: string; workItemId: string; fileName: string; url: string; mimeType: string; sizeBytes: number }>;
    if (atts.length) await prisma.workItemAttachment.createMany({ data: atts });
  }

  // ── 20. More products (services catalog) ──────────────────────────────────
  if ((await prisma.product.count({ where: { orgId } })) <= 1) {
    await prisma.product.createMany({
      data: [
        { orgId, name: "ATO Engineering Services", sku: "ATO-ENG", category: "Service", description: "RMF/ATO package preparation and sustainment.", status: "active" },
        { orgId, name: "CMMC Assessment Support", sku: "CMMC-SUP", category: "Service", description: "C3PAO readiness, SSP/POA&M authoring, evidence assembly.", status: "active" },
        { orgId, name: "Continuous Monitoring (ConMon)", sku: "CONMON", category: "Service", description: "Ongoing vulnerability scanning and control monitoring.", status: "active" },
      ],
    });
  }

  // ── 21. Wire chat bots into channels ──────────────────────────────────────
  const bots = await prisma.chatBot.findMany({ where: { orgId }, select: { id: true, key: true } });
  const channels = await prisma.chatChannel.findMany({ where: { orgId }, select: { id: true, slug: true } });
  const botByKey = new Map(bots.map((b) => [b.key, b.id]));
  const chBySlug = new Map(channels.map((c) => [c.slug, c.id]));
  const wire = async (botKey: string, chSlug: string, autoRespond: boolean) => {
    const botId = botByKey.get(botKey), channelId = chBySlug.get(chSlug);
    if (botId && channelId) await prisma.chatBotChannel.upsert({ where: { botId_channelId: { botId, channelId } }, update: {}, create: { botId, channelId, autoRespond, enabled: true } });
  };
  await wire("standup", "sentinel-eng", true);
  await wire("notetaker", "security-compliance", false);
  await wire("answerer", "general", true);

  // ── Summary ───────────────────────────────────────────────────────────────
  const counts = await Promise.all(
    (["employee", "payRun", "taxRate", "invoice", "journalEntry", "bankAccount", "goal", "milestone", "kpi", "savedReport", "customField", "workRole", "ipAllowlist", "integration", "webhook", "mcpServer", "egressDecisionRow", "document", "feedbackItem", "workItemLink"] as const).map((m) =>
      (prisma[m] as { count: (a?: unknown) => Promise<number> }).count(),
    ),
  );
  console.log("✅ Filled Apex Defense Systems — every page now has data:", {
    orgId,
    employees: counts[0], payRuns: counts[1], taxRates: counts[2], invoices: counts[3], journalEntries: counts[4], bankAccounts: counts[5],
    goals: counts[6], milestones: counts[7], kpis: counts[8], savedReports: counts[9], customFields: counts[10], workRoles: counts[11],
    ipAllowlists: counts[12], integrations: counts[13], webhooks: counts[14], mcpServers: counts[15], egressDecisions: counts[16], documents: counts[17], feedback: counts[18], workItemLinks: counts[19],
    url: `https://defcon.fightingsmartcyber.com/${SLUG}`,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
