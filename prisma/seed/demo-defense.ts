/**
 * Investor-demo seed: "Apex Defense Systems" — a believable CMMC-tracked
 * defense contractor running a CUI program, so the compliance / classification
 * / finance / sprint screens are populated and on-theme for a live demo.
 *
 * SAFE + IDEMPOTENT: standalone (NOT wired into `npm run seed`), keyed on a
 * unique slug, every write upserted or sentinel-guarded. Re-running only
 * touches this one org. Never resets/deletes anything.
 *
 * Loads DATABASE_URL from .env.local itself (nothing secret printed).
 *
 * Run:  cd /home/defcon/cosmos-saas && npx tsx prisma/seed/demo-defense.ts
 */
import { Prisma } from "@prisma/client";
import { makePrismaClient } from "./shared/prisma-client";
import { readFileSync } from "node:fs";
import { upsertRoadmapNodes } from "../../src/lib/roadmap/import";
import { DEMO_APEX_ROADMAP } from "./demo-defense-roadmap";

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
// .env's in-container `cosmos-postgres` hostname (importing @prisma/client auto-loads .env).
const DB_URL = loadEnv();
const prisma = makePrismaClient(DB_URL);

const SLUG = "apex-defense";
const PKEY = "SENTINEL";
const JON_EMAIL = "jon@fightingsmartcyber.com";

const NOW = Date.now();
const day = 86400000;
const d = (days: number) => new Date(NOW + days * day);

/**
 * Resolve a user by email. `User.email` has NO @unique (only googleId/auth0UserId
 * are), so this findFirst is the ONLY idempotency key — match case-insensitively
 * + trimmed so we reliably hit an existing real account despite case/whitespace.
 *
 * `requireExisting` (used for the REAL, Google-connected owner): if no row matches,
 * THROW instead of minting a phantom duplicate `User` (no googleId) that would be
 * made OWNER of the demo org — splitting the real account. The *.local demo
 * personas, whose sole creator is this seed, are created if absent.
 */
async function findOrCreateUser(
  email: string,
  displayName: string,
  opts: { requireExisting?: boolean } = {},
) {
  const normalized = email.trim();
  const existing = await prisma.user.findFirst({
    where: { email: { equals: normalized, mode: "insensitive" } },
  });
  if (existing) return existing;
  if (opts.requireExisting) {
    throw new Error(
      `Refusing to seed: real owner "${normalized}" has no User row in this database. ` +
        `Creating one would mint a phantom OWNER (no googleId) and split the real account. ` +
        `Point .env.local at a DB where this account exists (sign in via Google first), or fix the email.`,
    );
  }
  return prisma.user.create({ data: { email: normalized, displayName, avatarUrl: null } });
}

async function ensureNamedChannel(
  orgId: string,
  creatorUserId: string,
  slug: string,
  name: string,
  topic: string,
) {
  const existing = await prisma.chatChannel.findFirst({ where: { orgId, slug }, select: { id: true } });
  if (existing) return existing.id;
  const ch = await prisma.chatChannel.create({
    data: { orgId, kind: "CHANNEL", name, slug, topic, isPrivate: false, createdById: creatorUserId },
    select: { id: true },
  });
  return ch.id;
}

async function ensureGeneralChannel(orgId: string, creatorUserId: string) {
  const existing = await prisma.chatChannel.findFirst({ where: { orgId, isGeneral: true }, select: { id: true } });
  if (existing) return existing.id;
  try {
    const ch = await prisma.chatChannel.create({
      data: { orgId, kind: "CHANNEL", name: "general", slug: "general", isGeneral: true, isPrivate: false, createdById: creatorUserId },
      select: { id: true },
    });
    return ch.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const row = await prisma.chatChannel.findFirst({ where: { orgId, isGeneral: true }, select: { id: true } });
      if (row) return row.id;
    }
    throw e;
  }
}

async function joinChannel(channelId: string, userId: string, isAdmin: boolean) {
  await prisma.chatChannelMember.upsert({
    where: { channelId_userId: { channelId, userId } },
    update: {},
    create: { channelId, userId, role: isAdmin ? "ADMIN" : "MEMBER" },
  });
}

async function main() {
  // ── 1. Org (ENTERPRISE plan; GOV tenant class via the fail-closed default) ─
  // settings.isDemo flags this as walkthrough/sample data so the UI can show a
  // "Demo data" banner and offer one-step removal (see the demo teardown script).
  const demoSettings = {
    isDemo: true,
    demoLabel: "Walkthrough / sample data — safe to delete",
  } satisfies Prisma.InputJsonValue;
  const org = await prisma.organization.upsert({
    where: { slug: SLUG },
    update: { plan: "ENTERPRISE", name: "Apex Defense Systems", themePrimary: "#1f3a5f", settings: demoSettings },
    create: { name: "Apex Defense Systems", slug: SLUG, plan: "ENTERPRISE", themePrimary: "#1f3a5f", settings: demoSettings },
  });

  // ── 2. People ─────────────────────────────────────────────────────────────
  const jon = await findOrCreateUser(JON_EMAIL, "Jon Rannabargar", { requireExisting: true }); // real user (Google connected) → OWNER
  const dana = await findOrCreateUser("dana.reyes@apex-defense.local", "Dana Reyes"); // ISSO / Security Lead
  const marcus = await findOrCreateUser("marcus.hale@apex-defense.local", "Marcus Hale"); // Program Manager
  const priya = await findOrCreateUser("priya.nair@apex-defense.local", "Priya Nair"); // Lead Engineer
  const tom = await findOrCreateUser("tom.becker@apex-defense.local", "Tom Becker"); // Compliance Analyst

  const memberRoles: Array<[string, "OWNER" | "ADMIN" | "MEMBER" | "VIEWER"]> = [
    [jon.id, "OWNER"],
    [dana.id, "ADMIN"],
    [marcus.id, "MEMBER"],
    [priya.id, "MEMBER"],
    [tom.id, "VIEWER"],
  ];
  for (const [userId, role] of memberRoles) {
    await prisma.orgMember.upsert({
      where: { orgId_userId: { orgId: org.id, userId } },
      update: { role },
      create: { orgId: org.id, userId, role },
    });
  }
  const jonMember = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId: org.id, userId: jon.id } },
    select: { id: true },
  });

  // ── 3. Project + KANBAN board + columns ───────────────────────────────────
  let project = await prisma.project.findFirst({ where: { orgId: org.id, key: PKEY }, select: { id: true } });
  if (!project) {
    project = await prisma.$transaction(async (tx) => {
      const p = await tx.project.create({
        data: {
          orgId: org.id,
          name: "Sentinel Program",
          key: PKEY,
          description: "USAF cyber situational-awareness platform (CUI). CMMC L2 / NIST SP 800-171 in scope.",
        },
        select: { id: true },
      });
      const board = await tx.board.create({
        data: { orgId: org.id, projectId: p.id, name: "Board", type: "KANBAN", sortOrder: 0 },
        select: { id: true },
      });
      await tx.boardColumn.createMany({
        data: [
          { boardId: board.id, name: "Backlog", key: "backlog", color: "#94a3b8", sortOrder: 0, category: "TODO" },
          { boardId: board.id, name: "To Do", key: "todo", color: "#60a5fa", sortOrder: 1, category: "TODO" },
          { boardId: board.id, name: "In Progress", key: "in-progress", color: "#fbbf24", sortOrder: 2, category: "IN_PROGRESS" },
          { boardId: board.id, name: "Review", key: "review", color: "#a78bfa", sortOrder: 3, category: "IN_PROGRESS" },
          { boardId: board.id, name: "Done", key: "done", color: "#34d399", sortOrder: 4, category: "DONE" },
        ],
      });
      if (jonMember) await tx.projectMember.create({ data: { projectId: p.id, orgMemberId: jonMember.id, role: "MANAGER" } });
      return { id: p.id };
    });
  }
  const projectId = project.id;

  // Built-in "Task" type (created by main seed; verified present).
  const taskType = await prisma.workItemType.findFirst({ where: { isBuiltIn: true, key: "software.task" }, select: { id: true } });
  if (!taskType) throw new Error("built-in software.task WorkItemType missing — run `npm run seed` first");

  // ── 4. Active sprint (Increment 2 · Sprint 5) — engineered so the AI brief
  //      reads "57% complete, ~70% time elapsed, 2 overdue → at risk". ────────
  const interval = await prisma.interval.upsert({
    where: { projectId_number: { projectId, number: 5 } },
    update: { status: "ACTIVE", startDate: d(-10), endDate: d(5) },
    create: {
      orgId: org.id,
      projectId,
      intervalKind: "SPRINT",
      number: 5,
      name: "Increment 2 · Sprint 5",
      sectorLabel: "Sprint",
      goal: "Close ATO evidence for the AC/AU/SC control families and clear CAT I/II findings ahead of the C3PAO assessment.",
      startDate: d(-10),
      endDate: d(5),
      status: "ACTIVE",
    },
    select: { id: true },
  });

  // ── 5. Work items (defense/cyber themed) ──────────────────────────────────
  if ((await prisma.workItem.count({ where: { orgId: org.id, projectId } })) === 0) {
    const items: Array<{
      t: string; pts: number; col: string; done: Date | null;
      due: Date | null; who: string; pri: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; cui: boolean;
    }> = [
      { t: "Implement FIPS 140-3 validated crypto module for data-at-rest", pts: 8, col: "done", done: d(-5), due: null, who: priya.id, pri: "HIGH", cui: true },
      { t: "Remediate STIG CAT I findings on the RHEL 9 baseline", pts: 5, col: "done", done: d(-3), due: null, who: priya.id, pri: "CRITICAL", cui: false },
      { t: "CUI tagging + DLP enforcement on the telemetry pipeline", pts: 8, col: "done", done: d(-2), due: null, who: dana.id, pri: "HIGH", cui: true },
      { t: "ATO package: update SSP control families AC, AU, SC", pts: 13, col: "in-progress", done: null, due: d(-2), who: dana.id, pri: "CRITICAL", cui: true },
      { t: "CAC/PIV multifactor authentication integration", pts: 5, col: "done", done: d(-1), due: null, who: priya.id, pri: "HIGH", cui: false },
      { t: "Remediate Q2 Nessus vulnerability findings (CAT II)", pts: 5, col: "todo", done: null, due: d(-1), who: priya.id, pri: "HIGH", cui: false },
      { t: "Configure cross-domain boundary protection rules", pts: 8, col: "done", done: d(-0.5), due: null, who: jon.id, pri: "MEDIUM", cui: false },
      { t: "Author incident-response runbook for CUI spillage", pts: 3, col: "review", done: null, due: d(2), who: dana.id, pri: "MEDIUM", cui: true },
      { t: "Supply-chain risk assessment (NIST SP 800-161) for subcontractors", pts: 5, col: "todo", done: null, due: d(5), who: marcus.id, pri: "MEDIUM", cui: false },
    ];
    await prisma.workItem.createMany({
      data: items.map((it, i) => ({
        orgId: org.id,
        projectId,
        workItemTypeId: taskType.id,
        intervalId: interval.id,
        title: it.t,
        columnKey: it.col,
        ticketNumber: i + 1,
        sortOrder: i,
        priority: it.pri,
        assigneeId: it.who,
        storyPoints: it.pts,
        dueDate: it.due,
        completedAt: it.done,
        createdById: jon.id,
        tags: it.cui ? ["CUI"] : [],
      })),
    });
  }

  // ── 6. Project-level CUI classification ───────────────────────────────────
  await prisma.dataClassification.upsert({
    where: { orgId_projectId: { orgId: org.id, projectId } },
    update: { level: "CUI", markings: ["CUI//SP-PROP", "CUI//SP-EXPT"], appliedById: jon.id },
    create: {
      orgId: org.id,
      projectId,
      level: "CUI",
      markings: ["CUI//SP-PROP", "CUI//SP-EXPT"],
      handlingInstructions:
        "Controlled Unclassified Information. Handle per 32 CFR Part 2002 and DFARS 252.204-7012. Store only on the GovCloud enclave; encrypt at rest (FIPS 140-3) and in transit. No dissemination outside the program without ISSO approval.",
      appliedById: jon.id,
    },
  });

  // ── 7. Compliance controls (CMMC L2 + NIST 800-171), mixed statuses ───────
  type Ctl = {
    fw: "CMMC_L2" | "NIST_800_171";
    id: string;
    title: string;
    status: "NOT_ASSESSED" | "IN_PROGRESS" | "IMPLEMENTED" | "PARTIALLY_IMPLEMENTED" | "NOT_APPLICABLE" | "FAILED";
    notes?: string;
    due?: number;
  };
  const controls: Ctl[] = [
    { fw: "NIST_800_171", id: "3.1.1", title: "Limit system access to authorized users", status: "IMPLEMENTED" },
    { fw: "NIST_800_171", id: "3.1.2", title: "Limit system access to permitted transactions and functions", status: "IMPLEMENTED" },
    { fw: "NIST_800_171", id: "3.1.5", title: "Employ the principle of least privilege", status: "IMPLEMENTED" },
    { fw: "NIST_800_171", id: "3.1.12", title: "Monitor and control remote access sessions", status: "IN_PROGRESS", due: 14 },
    { fw: "NIST_800_171", id: "3.1.20", title: "Verify and control connections to external systems", status: "NOT_ASSESSED" },
    { fw: "NIST_800_171", id: "3.3.1", title: "Create and retain system audit logs and records", status: "IMPLEMENTED" },
    { fw: "NIST_800_171", id: "3.3.2", title: "Ensure actions are traceable to individual users", status: "IMPLEMENTED" },
    { fw: "NIST_800_171", id: "3.4.1", title: "Establish and maintain baseline configurations", status: "IMPLEMENTED" },
    { fw: "NIST_800_171", id: "3.4.2", title: "Establish and enforce security configuration settings", status: "IMPLEMENTED" },
    { fw: "NIST_800_171", id: "3.5.3", title: "Use multifactor authentication for network access", status: "IN_PROGRESS", notes: "CAC/PIV integration in progress — see SENTINEL-5.", due: 10 },
    { fw: "NIST_800_171", id: "3.5.10", title: "Store and transmit only cryptographically-protected passwords", status: "IMPLEMENTED" },
    { fw: "NIST_800_171", id: "3.8.3", title: "Sanitize or destroy media containing CUI before disposal", status: "IMPLEMENTED" },
    { fw: "NIST_800_171", id: "3.11.2", title: "Scan for vulnerabilities and remediate in a timely manner", status: "FAILED", notes: "Q2 Nessus scan surfaced 3 open CAT II findings past SLA — remediation tracked in SENTINEL-6.", due: -1 },
    { fw: "NIST_800_171", id: "3.13.1", title: "Monitor and control communications at system boundaries", status: "PARTIALLY_IMPLEMENTED", notes: "Cross-domain boundary rules deployed; egress monitoring pending." },
    { fw: "NIST_800_171", id: "3.13.11", title: "Employ FIPS-validated cryptography to protect CUI", status: "IMPLEMENTED", notes: "FIPS 140-3 module deployed for data-at-rest (SENTINEL-1)." },
    { fw: "NIST_800_171", id: "3.13.16", title: "Protect the confidentiality of CUI at rest", status: "IMPLEMENTED" },
    { fw: "NIST_800_171", id: "3.14.1", title: "Identify, report, and correct system flaws in a timely manner", status: "IN_PROGRESS", due: 7 },
    { fw: "NIST_800_171", id: "3.14.2", title: "Provide protection from malicious code at designated locations", status: "IMPLEMENTED" },
    { fw: "CMMC_L2", id: "AC.L2-3.1.3", title: "Control the flow of CUI in accordance with approved authorizations", status: "PARTIALLY_IMPLEMENTED" },
    { fw: "CMMC_L2", id: "IR.L2-3.6.1", title: "Establish an operational incident-handling capability", status: "IN_PROGRESS", notes: "CUI spillage runbook in review — SENTINEL-8.", due: 5 },
    { fw: "CMMC_L2", id: "SI.L2-3.14.6", title: "Monitor organizational systems including inbound/outbound traffic", status: "NOT_ASSESSED" },
    { fw: "CMMC_L2", id: "RA.L2-3.11.3", title: "Remediate vulnerabilities in accordance with risk assessments", status: "IN_PROGRESS", due: 3 },
  ];
  for (const c of controls) {
    const implemented = c.status === "IMPLEMENTED";
    await prisma.complianceControl.upsert({
      where: { orgId_framework_controlId: { orgId: org.id, framework: c.fw, controlId: c.id } },
      update: { title: c.title, status: c.status },
      create: {
        orgId: org.id,
        framework: c.fw,
        controlId: c.id,
        title: c.title,
        status: c.status,
        notes: c.notes ?? "",
        assessedById: jon.id,
        assessedAt: implemented ? d(-7) : null,
        dueDate: c.due != null ? d(c.due) : null,
      },
    });
  }

  // ── 8. Finance: contract funding (revenue) + subcontractor expenses ───────
  if ((await prisma.revenue.count({ where: { orgId: org.id } })) === 0) {
    await prisma.revenue.createMany({
      data: [
        { orgId: org.id, amount: 2_400_000, date: d(-120), client: "USAF AFLCMC", product: "Sentinel Program", type: "PROJECT_BASED", description: "CLIN 0001 — Base Year engineering", createdById: jon.id },
        { orgId: org.id, amount: 850_000, date: d(-60), client: "USAF AFLCMC", product: "Sentinel Program", type: "PROJECT_BASED", description: "CLIN 0002 — Cyber engineering services", createdById: jon.id },
        { orgId: org.id, amount: 1_200_000, date: d(-20), client: "USAF AFLCMC", product: "Sentinel Program", type: "PROJECT_BASED", description: "CLIN 0003 — Option Year 1 (partial obligation)", createdById: jon.id },
      ],
    });
  }
  if ((await prisma.expense.count({ where: { orgId: org.id } })) === 0) {
    await prisma.expense.createMany({
      data: [
        { orgId: org.id, amount: 128_400, currency: "USD", date: d(-8), category: "Subcontractor Labor", vendor: "Vector Systems LLC", description: "May subcontract labor (SUB-0142-001)", status: "APPROVED", submittedAt: d(-8), approvedAt: d(-7), approvedById: jon.id, createdById: marcus.id },
        { orgId: org.id, amount: 18_750, currency: "USD", date: d(-7), category: "Cloud Hosting", vendor: "CloudHarbor", description: "AWS GovCloud hosting — May", status: "APPROVED", submittedAt: d(-7), approvedAt: d(-6), approvedById: jon.id, createdById: priya.id },
        { orgId: org.id, amount: 42_000, currency: "USD", date: d(-2), category: "Security Assessment", vendor: "SecureScan Inc.", description: "Independent penetration test — pre-assessment", status: "SUBMITTED", submittedAt: d(-2), createdById: dana.id },
        { orgId: org.id, amount: 24_000, currency: "USD", date: d(-1), category: "Facilities", vendor: "Sentinel SCIF Holdings", description: "SCIF lease — May", status: "DRAFT", createdById: marcus.id },
      ],
    });
  }

  // ── 9. Partners (subcontractors) + product + contracts ────────────────────
  if ((await prisma.partner.count({ where: { orgId: org.id } })) === 0) {
    await prisma.partner.createMany({
      data: [
        { orgId: org.id, name: "Vector Systems LLC", type: "subcontractor", status: "active", contactName: "R. Vector", contactEmail: "contracts@vectorsystems.example", notes: "Cleared software subcontractor (Secret). Teamed on SSEB." },
        { orgId: org.id, name: "SecureScan Inc.", type: "vendor", status: "active", contactName: "M. Okafor", contactEmail: "engagements@securescan.example", notes: "Independent pentest / assessment vendor." },
        { orgId: org.id, name: "CloudHarbor", type: "vendor", status: "active", contactName: "Sales", contactEmail: "gov@cloudharbor.example", notes: "AWS GovCloud reseller / hosting." },
      ],
    });
  }
  const vector = await prisma.partner.findFirst({ where: { orgId: org.id, name: "Vector Systems LLC" }, select: { id: true } });
  if ((await prisma.product.count({ where: { orgId: org.id } })) === 0) {
    await prisma.product.create({
      data: { orgId: org.id, name: "Sentinel Cyber Situational-Awareness Platform", sku: "SCSAP", category: "Capability", description: "Real-time cyber SA platform delivered under the Sentinel program.", status: "active" },
    });
  }
  if ((await prisma.contract.count({ where: { orgId: org.id } })) === 0) {
    await prisma.contract.createMany({
      data: [
        { orgId: org.id, title: "Prime Contract FA8750-25-C-0142 — Sentinel Program", value: 4_450_000, currency: "USD", status: "active", startDate: d(-120), endDate: d(245), notes: "Firm-fixed-price + CPFF CLINs. CDRLs per DD1423. CUI per DFARS 252.204-7012." },
        { orgId: org.id, title: "Subcontract SUB-0142-001 — Vector Systems LLC", value: 1_200_000, currency: "USD", status: "active", partnerId: vector?.id ?? null, startDate: d(-90), endDate: d(180), notes: "Software engineering subcontract. Flowdowns: 7012, 7019, 7020." },
      ],
    });
  }

  // ── 10. Chat channels + a few messages ────────────────────────────────────
  const general = await ensureGeneralChannel(org.id, jon.id);
  const eng = await ensureNamedChannel(org.id, jon.id, "sentinel-eng", "sentinel-eng", "Sentinel engineering");
  const sec = await ensureNamedChannel(org.id, jon.id, "security-compliance", "security-compliance", "ISSO / CMMC / ATO");
  for (const ch of [general, eng, sec]) {
    await joinChannel(ch, jon.id, true);
    await joinChannel(ch, dana.id, false);
  }
  if ((await prisma.chatMessage.count({ where: { channelId: sec } })) === 0) {
    await prisma.chatMessage.create({ data: { channelId: sec, authorId: jon.id, content: "Reminder: the C3PAO assessment window opens in ~3 weeks. ATO evidence for the AC/AU/SC families needs to be closed out.", createdAt: d(-2) } });
    await prisma.chatMessage.create({ data: { channelId: sec, authorId: dana.id, content: "STIG CAT I findings on the RHEL baseline are remediated and evidence is uploaded. CAT II Nessus items are still open — tracked in SENTINEL-6.", createdAt: d(-1.5) } });
    await prisma.chatMessage.create({ data: { channelId: sec, authorId: jon.id, content: "Good. Let's get the SSP package (SENTINEL-4) over the line — it's our biggest overdue item this sprint.", createdAt: d(-1) } });
  }

  // ── 11. Notes ─────────────────────────────────────────────────────────────
  if ((await prisma.note.count({ where: { orgId: org.id } })) === 0) {
    await prisma.note.createMany({
      data: [
        { orgId: org.id, authorId: jon.id, title: "CMMC L2 — SSP Evidence Checklist", content: "Evidence to close before the C3PAO assessment: AC/AU/SC control families, FIPS 140-3 crypto module validation cert, CAC/PIV MFA screenshots, Nessus remediation report, CUI handling SOP." },
        { orgId: org.id, authorId: jon.id, title: "CUI Handling Procedures (DFARS 252.204-7012)", content: "All CUI stays on the GovCloud enclave. Mark documents CUI//SP-PROP. Encrypt at rest and in transit. Report spillage to the ISSO within 1 hour per the incident-response runbook." },
        { orgId: org.id, authorId: jon.id, title: "Sprint 5 Retro Notes", content: "ATO SSP package is the long pole and is now overdue. CAT II vuln remediation slipped. Subcontractor supply-chain assessment not yet started." },
      ],
    });
  }

  // ── 12. Historical audit entries (so the trail looks lived-in) ────────────
  if ((await prisma.auditLog.count({ where: { orgId: org.id } })) === 0) {
    await prisma.auditLog.createMany({
      data: [
        { orgId: org.id, userId: jon.id, action: "organization.created", entity: "organization", entityId: org.id, metadata: { plan: "ENTERPRISE" }, createdAt: d(-10) },
        { orgId: org.id, userId: jon.id, action: "org_member.invited", entity: "org_member", metadata: { email: "dana.reyes@apex-defense.local", role: "ADMIN" }, createdAt: d(-10) },
        { orgId: org.id, userId: jon.id, action: "org_member.invited", entity: "org_member", metadata: { email: "priya.nair@apex-defense.local", role: "MEMBER" }, createdAt: d(-9) },
        { orgId: org.id, userId: jon.id, action: "data_classification.upserted", entity: "data_classification", metadata: { level: "CUI", project: "SENTINEL" }, createdAt: d(-9) },
        { orgId: org.id, userId: dana.id, action: "compliance_control.created", entity: "compliance_control", metadata: { framework: "NIST_800_171", controlId: "3.13.11", status: "IMPLEMENTED" }, createdAt: d(-8) },
        { orgId: org.id, userId: dana.id, action: "compliance_control.updated", entity: "compliance_control", metadata: { framework: "NIST_800_171", controlId: "3.11.2", status: "FAILED" }, createdAt: d(-3) },
        { orgId: org.id, userId: jon.id, action: "expense.approved", entity: "expense", metadata: { vendor: "Vector Systems LLC", amount: 128400 }, createdAt: d(-7) },
        { orgId: org.id, userId: dana.id, action: "security_settings.updated", entity: "org_security_settings", metadata: { mfaRequired: true }, createdAt: d(-7) },
      ],
    });
  }

  // ── Roadmap (demo / walkthrough sample) ───────────────────────────────────
  await upsertRoadmapNodes(prisma, org.id, projectId, DEMO_APEX_ROADMAP, "replace");
  const projForFeatures = await prisma.project.findUnique({
    where: { id: projectId },
    select: { enabledFeatures: true },
  });
  if (projForFeatures && !projForFeatures.enabledFeatures.includes("roadmap")) {
    await prisma.project.update({
      where: { id: projectId },
      data: { enabledFeatures: { set: [...projForFeatures.enabledFeatures, "roadmap"] } },
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const [wi, ctl, exp, rev] = await Promise.all([
    prisma.workItem.count({ where: { orgId: org.id } }),
    prisma.complianceControl.count({ where: { orgId: org.id } }),
    prisma.expense.count({ where: { orgId: org.id } }),
    prisma.revenue.count({ where: { orgId: org.id } }),
  ]);
  console.log("✅ Seeded Apex Defense Systems:", {
    orgId: org.id,
    orgSlug: org.slug,
    plan: "ENTERPRISE",
    ownerUserId: jon.id,
    projectId,
    projectKey: PKEY,
    activeCycleId: interval.id,
    counts: { workItems: wi, complianceControls: ctl, expenses: exp, revenues: rev },
    url: `https://defcon.fightingsmartcyber.com/${org.slug}`,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
