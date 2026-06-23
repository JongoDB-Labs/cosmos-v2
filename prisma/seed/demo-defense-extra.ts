/* eslint-disable @typescript-eslint/no-explicit-any -- WIP investor-demo seed, orphaned (not imported by prisma/seed/index.ts); proper types deferred. Carried over from the v1 import. */
/**
 * Investor-demo seed (DEPTH): makes the Apex Defense "Sentinel" program look
 * mature — past sprints + velocity history, a fuller board & backlog, logged
 * time, a government BD pipeline, meetings, OKRs, 12 months of finance, the
 * full NIST SP 800-171 control set, comments, notes, and chat.
 *
 * ADDITIVE + IDEMPOTENT + SAFE: standalone (not in `npm run seed`), looks the
 * org up by slug, guards every section, and wraps each in try/catch so a
 * re-run never duplicates and one bad section can't abort the rest.
 *
 * Run AFTER demo-defense.ts:
 *   cd /home/defcon/cosmos-saas && npx tsx prisma/seed/demo-defense-extra.ts
 */
import { makePrismaClient } from "./shared/prisma-client";
import { readFileSync } from "node:fs";

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
  } catch {}
  return dbUrl;
}
// Prefer .env.local's DATABASE_URL explicitly so host runs don't fall back to
// .env's in-container `cosmos-postgres` hostname (importing @prisma/client auto-loads .env).
const DB_URL = loadEnv();
const prisma = makePrismaClient(DB_URL);
const SLUG = "apex-defense", PKEY = "SENTINEL";
const NOW = Date.now(), DAY = 86400000;
const d = (days: number) => new Date(NOW + days * DAY);
const log = (s: string) => console.log("  " + s);

async function findUser(email: string, name: string) {
  const e = await prisma.user.findFirst({ where: { email } });
  return e ?? prisma.user.create({ data: { email, displayName: name } });
}
async function section(name: string, fn: () => Promise<string>) {
  try { log(`${name}: ${await fn()}`); }
  catch (e) { log(`${name}: ⚠️ FAILED — ${(e as Error).message.split("\n")[0]}`); }
}

async function main() {
  const org = await prisma.organization.findFirst({ where: { slug: SLUG }, select: { id: true } });
  if (!org) throw new Error("run demo-defense.ts first (org apex-defense missing)");
  const orgId = org.id;
  const project = await prisma.project.findFirst({ where: { orgId, key: PKEY }, select: { id: true } });
  if (!project) throw new Error("Sentinel project missing");
  const projectId = project.id;

  // people (seed1 + a few more engineers so the team & assignees look staffed)
  const jon = await findUser("jon@fightingsmartcyber.com", "Jon Rannabargar");
  const dana = await findUser("dana.reyes@apex-defense.local", "Dana Reyes");
  const marcus = await findUser("marcus.hale@apex-defense.local", "Marcus Hale");
  const priya = await findUser("priya.nair@apex-defense.local", "Priya Nair");
  const tom = await findUser("tom.becker@apex-defense.local", "Tom Becker");
  const alicia = await findUser("alicia.chen@apex-defense.local", "Alicia Chen");
  const ben = await findUser("ben.okoro@apex-defense.local", "Ben Okoro");
  const sara = await findUser("sara.kim@apex-defense.local", "Sara Kim");
  for (const [u, role] of [[alicia, "MEMBER"], [ben, "MEMBER"], [sara, "MEMBER"]] as const) {
    await prisma.orgMember.upsert({
      where: { orgId_userId: { orgId, userId: u.id } }, update: { role }, create: { orgId, userId: u.id, role },
    });
  }
  const eng = [priya.id, alicia.id, ben.id, sara.id, dana.id]; // assignment pool
  const taskType = await prisma.workItemType.findFirst({ where: { isBuiltIn: true, key: "software.task" }, select: { id: true } });
  if (!taskType) throw new Error("built-in software.task type missing");
  const builtins = await prisma.workItemType.findMany({ where: { isBuiltIn: true }, select: { id: true, key: true } });
  const typeId = (label: string) => {
    const hit = builtins.find((t) => t.key.endsWith("." + label) || t.key === label);
    return hit?.id ?? taskType.id;
  };
  let ticket = ((await prisma.workItem.findFirst({ where: { orgId, projectId }, orderBy: { ticketNumber: "desc" }, select: { ticketNumber: true } }))?.ticketNumber ?? 0);

  // ── Past sprints + completed items (velocity history) ────────────────────
  const sprints = [
    { n: 1, name: "Increment 1 · Sprint 1", s: -80, e: -66, items: [
      ["Stand up GovCloud landing zone (IL4)", 8], ["Implement RMF control inheritance from the CSP", 5],
      ["Integrate Splunk for centralized audit logging", 5], ["Develop CUI data-flow diagrams for the SSP", 3],
      ["Establish PKI / CAC authentication", 8], ["Container image hardening (DISA STIG)", 5] ] },
    { n: 2, name: "Increment 1 · Sprint 2", s: -65, e: -51, items: [
      ["Build CI/CD pipeline with security gates", 8], ["Automate STIG compliance scanning (SCAP)", 5],
      ["Deploy FIPS-validated TLS across services", 5], ["Set up vulnerability management (ACAS/Nessus)", 5],
      ["Implement role-based access control (RBAC)", 8], ["Configure boundary firewall rules", 3],
      ["Telemetry ingestion service v1", 8] ] },
    { n: 3, name: "Increment 1 · Sprint 3", s: -50, e: -36, items: [
      ["Develop threat dashboard UI", 8], ["Integrate MISP threat-intelligence feed", 5],
      ["Privileged access management (PAM) rollout", 5], ["Configure SIEM correlation rules", 5],
      ["Data-at-rest encryption (FIPS 140-3)", 8], ["Implement session timeout & lockout policies", 3] ] },
    { n: 4, name: "Increment 2 · Sprint 4", s: -35, e: -21, items: [
      ["Anomaly-detection model v1", 13], ["Develop API gateway with mTLS", 8],
      ["Configure DLP for CUI egress", 5], ["Implement backup & DR runbook", 5],
      ["Penetration test remediation (round 1)", 8], ["SBOM generation in build pipeline", 3],
      ["Implement audit-log tamper protection", 5] ] },
  ];
  await section("past sprints + done items", async () => {
    if ((await prisma.cycle.count({ where: { orgId, projectId, status: "COMPLETED" } })) > 0) return "already present (skipped)";
    let made = 0, ci = 0;
    for (const sp of sprints) {
      const cyc = await prisma.cycle.upsert({
        where: { projectId_number: { projectId, number: sp.n } },
        update: { status: "COMPLETED", startDate: d(sp.s), endDate: d(sp.e) },
        create: { orgId, projectId, cycleKind: "SPRINT", number: sp.n, name: sp.name, sectorLabel: "Sprint",
          goal: "Increment delivery + control implementation.", startDate: d(sp.s), endDate: d(sp.e), status: "COMPLETED" },
        select: { id: true },
      });
      const rows = sp.items.map(([title, pts], i) => ({
        orgId, projectId, workItemTypeId: typeId(i === 0 ? "story" : "task"), cycleId: cyc.id,
        title: title as string, columnKey: "done", ticketNumber: ++ticket, sortOrder: ++ci,
        priority: "MEDIUM" as const, assigneeId: eng[(ci + i) % eng.length], storyPoints: pts as number,
        completedAt: d(sp.e - 1), createdById: jon.id, tags: [] as string[],
      }));
      await prisma.workItem.createMany({ data: rows });
      made += rows.length;
    }
    return `${sprints.length} completed sprints, ${made} done items`;
  });

  // ── Backlog (future roadmap, not yet in a sprint) ────────────────────────
  await section("backlog items", async () => {
    if (await prisma.workItem.findFirst({ where: { orgId, projectId, title: "Increment 3 capability roadmap" } })) return "already present (skipped)";
    const backlog: Array<[string, number, string, string]> = [
      ["Increment 3 capability roadmap", 13, "epic", "CRITICAL"],
      ["ML-based threat scoring v2", 13, "epic", "HIGH"],
      ["Multi-region failover (GovCloud East/West)", 8, "story", "HIGH"],
      ["FedRAMP High readiness assessment", 8, "story", "MEDIUM"],
      ["Integrate JADC2 data fabric", 13, "epic", "MEDIUM"],
      ["CAC-enabled mobile companion app", 8, "story", "LOW"],
      ["Automated POA&M remediation workflows", 5, "task", "HIGH"],
      ["Quantum-resistant crypto evaluation", 5, "task", "LOW"],
      ["Real-time collaboration for SOC analysts", 5, "story", "MEDIUM"],
      ["Expand to IL5 enclave", 8, "story", "MEDIUM"],
      ["AI explainability for threat verdicts", 5, "task", "MEDIUM"],
      ["PMO self-service reporting portal", 5, "story", "LOW"],
    ];
    const rows = backlog.map(([title, pts, type, pri], i) => ({
      orgId, projectId, workItemTypeId: typeId(type), title, columnKey: i % 3 === 0 ? "backlog" : "todo",
      ticketNumber: ++ticket, sortOrder: i, priority: pri as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      assigneeId: i % 4 === 0 ? null : eng[i % eng.length], storyPoints: pts, createdById: jon.id, tags: [] as string[],
    }));
    await prisma.workItem.createMany({ data: rows });
    return `${rows.length} backlog items`;
  });

  // ── Comments + activity on notable items ─────────────────────────────────
  await section("comments + activity", async () => {
    if ((await prisma.comment.count({ where: { orgId } })) > 0) return "already present (skipped)";
    const ato = await prisma.workItem.findFirst({ where: { orgId, projectId, title: { contains: "ATO package" } }, select: { id: true } });
    const vuln = await prisma.workItem.findFirst({ where: { orgId, projectId, title: { contains: "Nessus" } }, select: { id: true } });
    let c = 0;
    if (ato) {
      await prisma.comment.createMany({ data: [
        { orgId, workItemId: ato.id, authorId: dana.id, content: "AC and AU families are drafted. SC needs the boundary diagram from Priya before I can close it out.", createdAt: d(-3) },
        { orgId, workItemId: ato.id, authorId: jon.id, content: "This is our critical path for the C3PAO. Let's pair on it Thursday.", createdAt: d(-2) },
      ]});
      await prisma.activity.createMany({ data: [
        { orgId, workItemId: ato.id, userId: dana.id, action: "status_changed", field: "columnKey", oldValue: "todo", newValue: "in-progress", createdAt: d(-6) },
        { orgId, workItemId: ato.id, userId: dana.id, action: "assignee_changed", field: "assigneeId", oldValue: null, newValue: "Dana Reyes", createdAt: d(-6) },
      ]});
      c += 2;
    }
    if (vuln) {
      await prisma.comment.create({ data: { orgId, workItemId: vuln.id, authorId: priya.id, content: "3 CAT II findings left — patching the RHEL hosts this week, then re-scan.", createdAt: d(-1) } });
      await prisma.activity.create({ data: { orgId, workItemId: vuln.id, userId: priya.id, action: "commented", createdAt: d(-1) } });
      c += 1;
    }
    return `${c} comments + activity`;
  });

  // ── Time entries (logged + approved → time tracking & billable finance) ──
  await section("time entries", async () => {
    if ((await prisma.timeEntry.count({ where: { orgId } })) > 0) return "already present (skipped)";
    const items = await prisma.workItem.findMany({ where: { orgId, projectId, completedAt: null }, select: { id: true }, take: 12 });
    const rate: Record<string, number> = { [priya.id]: 195, [alicia.id]: 185, [ben.id]: 185, [sara.id]: 175, [dana.id]: 215 };
    const desc = ["Engineering — Sentinel", "ATO evidence prep", "STIG remediation", "Code review & test", "SIEM rule tuning", "Sprint ceremonies"];
    const rows: any[] = [];
    for (let dd = 18; dd >= 0; dd--) {
      const date = d(-dd); const wd = date.getDay();
      if (wd === 0 || wd === 6) continue; // weekdays only
      eng.forEach((uid, i) => {
        const hours = 6 + ((dd + i) % 3); // 6-8h
        rows.push({ orgId, userId: uid, projectId, workItemId: items[(dd + i) % Math.max(items.length, 1)]?.id ?? null,
          date, hours, rate: rate[uid] ?? 180, description: desc[(dd + i) % desc.length],
          billableType: i === 4 && dd % 4 === 0 ? "NON_BILLABLE" : "BILLABLE",
          status: "APPROVED", approvedById: jon.id, approvedAt: d(-dd + 1) });
      });
    }
    await prisma.timeEntry.createMany({ data: rows });
    const hrs = rows.reduce((s, r) => s + r.hours, 0);
    return `${rows.length} approved entries (~${hrs}h)`;
  });

  // ── Government BD pipeline (CRM) ─────────────────────────────────────────
  await section("CRM contacts + pipeline", async () => {
    if ((await prisma.crmContact.count({ where: { orgId } })) > 0) return "already present (skipped)";
    const rows = [
      { name: "Lt Col Sarah Mitchell — PM, USAF AFLCMC", stage: "CLOSED_WON", dealValue: 4450000, contactInfo: "s.mitchell@us.af.mil", notes: "Sentinel program manager (customer).", ownerId: marcus.id },
      { name: "Maria Gonzalez — Contracting Officer, AFLCMC/PK", stage: "CLOSED_WON", dealValue: 4450000, contactInfo: "maria.gonzalez@us.af.mil", notes: "KO of record on FA8750-25-C-0142.", ownerId: marcus.id },
      { name: "MDA — Sentinel sustainment (Option Year 2)", stage: "NEGOTIATION", dealValue: 4450000, contactInfo: "acq@mda.mil", notes: "OY2 sustainment — in negotiation.", ownerId: jon.id },
      { name: "Navy PMW-160 — Cyber SA follow-on", stage: "PROPOSAL", dealValue: 5200000, contactInfo: "pmw160.bd@navy.mil", notes: "Proposal submitted; orals next month.", ownerId: marcus.id },
      { name: "Army PEO C3T — RMF automation", stage: "QUALIFIED", dealValue: 3100000, contactInfo: "peoc3t.bd@army.mil", notes: "RFI responded; awaiting draft RFP.", ownerId: marcus.id },
      { name: "DISA — Zero Trust pilot", stage: "LEAD", dealValue: 2400000, contactInfo: "ztp@disa.mil", notes: "Early shaping via SBIR.", ownerId: jon.id },
      { name: "DARPA — AI4Cyber BAA", stage: "LEAD", dealValue: 1800000, contactInfo: "i2o@darpa.mil", notes: "White paper in draft.", ownerId: priya.id },
      { name: "DHS CISA — CDM task order", stage: "CLOSED_LOST", dealValue: 2900000, contactInfo: "cdm@cisa.dhs.gov", notes: "Lost to incumbent on price.", ownerId: marcus.id },
    ];
    await prisma.crmContact.createMany({ data: rows.map((r) => ({ orgId, ...r })) });
    return `${rows.length} contacts across the pipeline`;
  });

  // ── Meetings (past reviews/retros + upcoming) ────────────────────────────
  await section("meetings", async () => {
    if ((await prisma.syncMeeting.count({ where: { orgId } })) > 0) return "already present (skipped)";
    const mtg = [
      { title: "Sprint 4 Review", t: "SPRINT_REVIEW", s: "MEETING_COMPLETED", when: -21 },
      { title: "Sprint 4 Retrospective", t: "RETROSPECTIVE", s: "MEETING_COMPLETED", when: -21 },
      { title: "Monthly Program IPR with PMO", t: "OTHER", s: "MEETING_COMPLETED", when: -18 },
      { title: "Technical Interchange Meeting — Boundary Architecture", t: "OTHER", s: "MEETING_COMPLETED", when: -14 },
      { title: "Sprint 5 Planning", t: "SPRINT_PLANNING", s: "MEETING_COMPLETED", when: -10 },
      { title: "CMMC Evidence Sync with ISSO", t: "OTHER", s: "MEETING_COMPLETED", when: -4 },
      { title: "Daily Standup", t: "STANDUP", s: "SCHEDULED", when: 1 },
      { title: "CMMC Pre-Assessment Review", t: "OTHER", s: "SCHEDULED", when: 2 },
      { title: "Sprint 5 Review", t: "SPRINT_REVIEW", s: "SCHEDULED", when: 5 },
      { title: "C3PAO Readiness IPR", t: "OTHER", s: "SCHEDULED", when: 12 },
    ];
    for (const m of mtg) {
      const row = await prisma.syncMeeting.create({ data: {
        orgId, projectId, title: m.title, meetingDate: d(m.when), meetingType: m.t as any, status: m.s as any,
        notes: m.s === "MEETING_COMPLETED" ? "Action items captured; see linked work items." : "", createdById: jon.id } });
      await prisma.meetingAttendee.createMany({ data: [jon.id, dana.id, priya.id, marcus.id].map((uid) => ({ meetingId: row.id, userId: uid })) });
    }
    return `${mtg.length} meetings w/ attendees`;
  });

  // ── OKRs (program objectives) ────────────────────────────────────────────
  await section("OKRs", async () => {
    if ((await prisma.objective.count({ where: { orgId, projectId } })) > 0) return "already present (skipped)";
    const objs = [
      { title: "Achieve CMMC Level 2 certification", period: "Q3 2026", progress: 78, status: "ACTIVE", owner: dana.id, krs: [
        { title: "NIST 800-171 controls implemented", s: 0, c: 84, t: 110, unit: "controls", st: "ON_TRACK" },
        { title: "Open POA&M items closed", s: 40, c: 31, t: 0, unit: "items", st: "AT_RISK" },
        { title: "C3PAO assessment scheduled", s: 0, c: 0, t: 1, unit: "", st: "IN_PROGRESS" } ] },
      { title: "Deliver Increment 2 on schedule", period: "Q3 2026", progress: 65, status: "ACTIVE", owner: marcus.id, krs: [
        { title: "Average sprint velocity", s: 30, c: 42, t: 45, unit: "pts", st: "ON_TRACK" },
        { title: "Increment 2 features delivered", s: 0, c: 7, t: 12, unit: "features", st: "IN_PROGRESS" },
        { title: "Defect escape rate", s: 8, c: 3, t: 2, unit: "%", st: "ON_TRACK" } ] },
      { title: "Grow the defense backlog to $15M", period: "FY26", progress: 52, status: "ACTIVE", owner: jon.id, krs: [
        { title: "Qualified pipeline value", s: 4, c: 11, t: 15, unit: "$M", st: "ON_TRACK" },
        { title: "Proposals submitted", s: 0, c: 2, t: 4, unit: "", st: "IN_PROGRESS" } ] },
    ];
    let kr = 0;
    for (const o of objs) {
      const obj = await prisma.objective.create({ data: { orgId, projectId, title: o.title, period: o.period, progress: o.progress, status: o.status as any, ownerId: o.owner } });
      await prisma.keyResult.createMany({ data: o.krs.map((k, i) => ({ objectiveId: obj.id, title: k.title, startValue: k.s, currentValue: k.c, targetValue: k.t, unit: k.unit, status: k.st as any, sortOrder: i })) });
      kr += o.krs.length;
    }
    return `${objs.length} objectives, ${kr} key results`;
  });

  // ── 12 months of finance (trend) ─────────────────────────────────────────
  await section("finance history (12 mo)", async () => {
    if ((await prisma.revenue.count({ where: { orgId } })) > 4) return "already present (skipped)";
    const exp: any[] = [], rev: any[] = [];
    for (let mo = 12; mo >= 1; mo--) {
      const date = d(-mo * 30);
      exp.push({ orgId, amount: 285000 + ((mo * 7919) % 60000), currency: "USD", date, category: "Direct Labor", vendor: "Apex Defense Systems", description: `Direct labor — month -${mo}`, status: "APPROVED", submittedAt: date, approvedAt: date, approvedById: jon.id, createdById: marcus.id });
      exp.push({ orgId, amount: 16500 + ((mo * 311) % 4000), currency: "USD", date, category: "Cloud Hosting", vendor: "CloudHarbor", description: `AWS GovCloud — month -${mo}`, status: "APPROVED", submittedAt: date, approvedAt: date, approvedById: jon.id, createdById: priya.id });
      if (mo % 3 === 0) exp.push({ orgId, amount: 128400, currency: "USD", date, category: "Subcontractor Labor", vendor: "Vector Systems LLC", description: `Subcontract — month -${mo}`, status: "APPROVED", submittedAt: date, approvedAt: date, approvedById: jon.id, createdById: marcus.id });
      if (mo % 4 === 0) rev.push({ orgId, amount: 1112500, currency: "USD", date, client: "USAF AFLCMC", product: "Sentinel Program", type: "PROJECT_BASED", description: `CLIN funding tranche — month -${mo}`, createdById: jon.id });
    }
    await prisma.expense.createMany({ data: exp });
    await prisma.revenue.createMany({ data: rev });
    return `${exp.length} expenses + ${rev.length} revenue across 12 months`;
  });

  // ── More notes ───────────────────────────────────────────────────────────
  await section("notes", async () => {
    if ((await prisma.note.count({ where: { orgId } })) > 3) return "already present (skipped)";
    const notes = [
      ["System Security Plan (SSP) — Section 3.1 Access Control", "Documents AC family implementation: least privilege, separation of duties, remote-access control, CUI flow enforcement. Evidence linked to SENTINEL work items."],
      ["POA&M — Open Items Tracker", "Open: 3.11.2 vulnerability scanning (CAT II remediation), 3.5.3 MFA rollout to remaining hosts, 3.13.1 egress monitoring. Target closure before the C3PAO window."],
      ["Increment 2 — Architecture Decision Record", "Boundary architecture: cross-domain solution + mTLS API gateway. Data-at-rest via FIPS 140-3 module on the GovCloud enclave."],
      ["Subcontractor Flowdown Matrix", "DFARS 252.204-7012 / -7019 / -7020 flowed down to Vector Systems LLC. SPRS scores tracked."],
      ["C3PAO Assessment Readiness Plan", "Evidence package owners, control walkthrough schedule, and SSP/POA&M freeze date."],
    ];
    await prisma.note.createMany({ data: notes.map(([title, content]) => ({ orgId, authorId: jon.id, title, content })) });
    return `${notes.length} program notes`;
  });

  // ── More chat ────────────────────────────────────────────────────────────
  await section("chat messages", async () => {
    const eng = await prisma.chatChannel.findFirst({ where: { orgId, slug: "sentinel-eng" }, select: { id: true } });
    if (!eng) return "channel missing (skipped)";
    if ((await prisma.chatMessage.count({ where: { channelId: eng.id } })) > 0) return "already present (skipped)";
    await prisma.chatMessage.createMany({ data: [
      { channelId: eng.id, authorId: priya.id, content: "FIPS module is validated and merged — data-at-rest is green. Updating SENTINEL-1.", createdAt: d(-5) },
      { channelId: eng.id, authorId: ben.id, content: "CI security gates are blocking on 2 high CVEs in a base image. Rebuilding from the hardened UBI.", createdAt: d(-4) },
      { channelId: eng.id, authorId: alicia.id, content: "mTLS gateway is up in the IL4 enclave. Latency looks good (<15ms p95).", createdAt: d(-3) },
      { channelId: eng.id, authorId: sara.id, content: "Regression suite green except the cross-domain test — flaky, looking into it.", createdAt: d(-2) },
      { channelId: eng.id, authorId: jon.id, content: "Great progress team. Sprint 5 review Friday — let's make the ATO package the headline.", createdAt: d(-1) },
    ]});
    return "5 engineering messages";
  });

  // ── Full NIST SP 800-171 control set (110) ───────────────────────────────
  await section("NIST 800-171 controls (full 110)", async () => {
    const N: Array<[string, string]> = [
      ["3.1.1","Limit system access to authorized users and devices"],["3.1.2","Limit access to permitted transactions and functions"],
      ["3.1.3","Control the flow of CUI in accordance with approved authorizations"],["3.1.4","Separate the duties of individuals to reduce risk"],
      ["3.1.5","Employ the principle of least privilege"],["3.1.6","Use non-privileged accounts for non-security functions"],
      ["3.1.7","Prevent non-privileged users from executing privileged functions"],["3.1.8","Limit unsuccessful logon attempts"],
      ["3.1.9","Provide privacy and security notices consistent with CUI rules"],["3.1.10","Use session lock with pattern-hiding displays"],
      ["3.1.11","Terminate user sessions after a defined condition"],["3.1.12","Monitor and control remote access sessions"],
      ["3.1.13","Employ cryptographic mechanisms to protect remote access"],["3.1.14","Route remote access via managed access control points"],
      ["3.1.15","Authorize remote execution of privileged commands"],["3.1.16","Authorize wireless access prior to allowing connections"],
      ["3.1.17","Protect wireless access using authentication and encryption"],["3.1.18","Control connection of mobile devices"],
      ["3.1.19","Encrypt CUI on mobile devices and platforms"],["3.1.20","Verify and control connections to external systems"],
      ["3.1.21","Limit use of portable storage devices on external systems"],["3.1.22","Control CUI posted or processed on publicly accessible systems"],
      ["3.2.1","Ensure personnel are trained on security risks and policies"],["3.2.2","Train personnel to carry out their security duties"],
      ["3.2.3","Provide security awareness training on insider threat"],
      ["3.3.1","Create and retain system audit logs and records"],["3.3.2","Ensure actions are traceable to individual users"],
      ["3.3.3","Review and update logged events"],["3.3.4","Alert on audit logging process failures"],
      ["3.3.5","Correlate audit review, analysis, and reporting"],["3.3.6","Provide audit record reduction and report generation"],
      ["3.3.7","Synchronize system clocks to an authoritative source"],["3.3.8","Protect audit information and tools from unauthorized access"],
      ["3.3.9","Limit management of audit logging to a privileged subset"],
      ["3.4.1","Establish and maintain baseline configurations and inventories"],["3.4.2","Establish and enforce security configuration settings"],
      ["3.4.3","Track, review, approve, and log configuration changes"],["3.4.4","Analyze the security impact of changes prior to implementation"],
      ["3.4.5","Define, document, and enforce access restrictions for changes"],["3.4.6","Employ the principle of least functionality"],
      ["3.4.7","Restrict nonessential programs, ports, protocols, and services"],["3.4.8","Apply deny-by-exception (blacklist/whitelist) for software"],
      ["3.4.9","Control and monitor user-installed software"],
      ["3.5.1","Identify system users, processes, and devices"],["3.5.2","Authenticate identities before granting access"],
      ["3.5.3","Use multifactor authentication for access"],["3.5.4","Employ replay-resistant authentication mechanisms"],
      ["3.5.5","Prevent reuse of identifiers for a defined period"],["3.5.6","Disable identifiers after a period of inactivity"],
      ["3.5.7","Enforce a minimum password complexity"],["3.5.8","Prohibit password reuse for a number of generations"],
      ["3.5.9","Allow temporary password use with immediate change"],["3.5.10","Store and transmit only cryptographically-protected passwords"],
      ["3.5.11","Obscure feedback of authentication information"],
      ["3.6.1","Establish an operational incident-handling capability"],["3.6.2","Track, document, and report incidents to officials"],
      ["3.6.3","Test the organizational incident response capability"],
      ["3.7.1","Perform maintenance on organizational systems"],["3.7.2","Provide controls on tools, techniques, and personnel for maintenance"],
      ["3.7.3","Sanitize equipment removed for off-site maintenance"],["3.7.4","Check media containing diagnostic programs for malicious code"],
      ["3.7.5","Require MFA to establish nonlocal maintenance sessions"],["3.7.6","Supervise maintenance activities of personnel without access"],
      ["3.8.1","Protect system media containing CUI"],["3.8.2","Limit access to CUI on system media to authorized users"],
      ["3.8.3","Sanitize or destroy system media before disposal or reuse"],["3.8.4","Mark media with necessary CUI markings and distribution limits"],
      ["3.8.5","Control access to media and maintain accountability during transport"],["3.8.6","Implement cryptographic protection of CUI on media in transport"],
      ["3.8.7","Control the use of removable media on system components"],["3.8.8","Prohibit use of portable storage with no identifiable owner"],
      ["3.8.9","Protect the confidentiality of backup CUI at storage locations"],
      ["3.9.1","Screen individuals prior to authorizing access to CUI"],["3.9.2","Protect CUI during personnel actions (termination/transfer)"],
      ["3.10.1","Limit physical access to systems and equipment"],["3.10.2","Protect and monitor the physical facility and infrastructure"],
      ["3.10.3","Escort visitors and monitor visitor activity"],["3.10.4","Maintain audit logs of physical access"],
      ["3.10.5","Control and manage physical access devices"],["3.10.6","Enforce safeguarding measures for CUI at alternate work sites"],
      ["3.11.1","Periodically assess risk to operations and assets"],["3.11.2","Scan for vulnerabilities and remediate in a timely manner"],
      ["3.11.3","Remediate vulnerabilities in accordance with risk assessments"],
      ["3.12.1","Periodically assess the security controls for effectiveness"],["3.12.2","Develop and implement plans of action (POA&M)"],
      ["3.12.3","Monitor security controls on an ongoing basis"],["3.12.4","Develop, document, and update System Security Plans"],
      ["3.13.1","Monitor and control communications at system boundaries"],["3.13.2","Employ architectural designs promoting effective security"],
      ["3.13.3","Separate user functionality from system management functionality"],["3.13.4","Prevent unauthorized information transfer via shared resources"],
      ["3.13.5","Implement subnetworks for publicly accessible components"],["3.13.6","Deny network traffic by default and allow by exception"],
      ["3.13.7","Prevent remote devices from split tunneling"],["3.13.8","Use cryptography to protect CUI during transmission"],
      ["3.13.9","Terminate network connections at the end of sessions"],["3.13.10","Establish and manage cryptographic keys"],
      ["3.13.11","Employ FIPS-validated cryptography to protect CUI"],["3.13.12","Prohibit remote activation of collaborative computing devices"],
      ["3.13.13","Control and monitor use of mobile code"],["3.13.14","Control and monitor use of VoIP technologies"],
      ["3.13.15","Protect the authenticity of communications sessions"],["3.13.16","Protect the confidentiality of CUI at rest"],
      ["3.14.1","Identify, report, and correct system flaws in a timely manner"],["3.14.2","Provide protection from malicious code"],
      ["3.14.3","Monitor security alerts and advisories and take action"],["3.14.4","Update malicious code protection mechanisms"],
      ["3.14.5","Perform periodic and real-time scans of the system"],["3.14.6","Monitor systems including inbound/outbound traffic"],
      ["3.14.7","Identify unauthorized use of organizational systems"],
    ];
    const IN_PROG = new Set(["3.1.12","3.1.18","3.3.8","3.4.9","3.5.3","3.7.5","3.12.2","3.13.7","3.14.1","3.6.3","3.11.3","3.13.10"]);
    const PARTIAL = new Set(["3.1.3","3.13.1","3.4.8","3.8.7","3.10.6","3.13.6"]);
    const NOT_ASSESSED = new Set(["3.2.3","3.7.6","3.9.2","3.13.14"]);
    const FAILED = new Set(["3.11.2"]);
    const stat = (id: string) =>
      FAILED.has(id) ? "FAILED" : IN_PROG.has(id) ? "IN_PROGRESS" : PARTIAL.has(id) ? "PARTIALLY_IMPLEMENTED" : NOT_ASSESSED.has(id) ? "NOT_ASSESSED" : "IMPLEMENTED";
    let n = 0;
    for (const [id, title] of N) {
      const s = stat(id);
      await prisma.complianceControl.upsert({
        where: { orgId_framework_controlId: { orgId, framework: "NIST_800_171", controlId: id } },
        update: { title, status: s as any },
        create: { orgId, framework: "NIST_800_171", controlId: id, title, status: s as any,
          assessedById: jon.id, assessedAt: s === "IMPLEMENTED" ? d(-20) : null, dueDate: s === "IMPLEMENTED" ? null : d(14) },
      });
      n++;
    }
    return `${n} controls upserted (full 800-171 baseline)`;
  });

  // ── summary ──────────────────────────────────────────────────────────────
  const [wi, te, crm, mtg, obj, ctl, exp] = await Promise.all([
    prisma.workItem.count({ where: { orgId } }), prisma.timeEntry.count({ where: { orgId } }),
    prisma.crmContact.count({ where: { orgId } }), prisma.syncMeeting.count({ where: { orgId } }),
    prisma.objective.count({ where: { orgId } }),
    prisma.complianceControl.count({ where: { orgId } }), prisma.expense.count({ where: { orgId } }),
  ]);
  console.log("\n✅ Apex Defense / Sentinel deepened:", { workItems: wi, timeEntries: te, crmContacts: crm, meetings: mtg, objectives: obj, complianceControls: ctl, expenses: exp });
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
