 
// TEMP — inspect demo org/project data. Delete after.
import { prisma } from "@/lib/db/client";
import { loadClinsWithBurn, loadClinBurnTimePhased } from "./burn";

async function main() {
  const org = await prisma.organization.findFirst({ where: { slug: "apex-defense" } });
  if (!org) { console.log("NO ORG apex-defense"); return; }
  const project = await prisma.project.findFirst({ where: { orgId: org.id, key: "SENTINEL" } });
  console.log("ORG", org.id, org.name, "| PROJECT", project?.id, project?.name, project?.key);
  if (!project) return;
  const orgId = org.id, projectId = project.id;

  const clins = await loadClinsWithBurn(orgId, projectId);
  console.log("\n=== CLINS (", clins.length, ") ===");
  for (const c of clins) console.log(`  ${c.code} | ${c.title} | ceil=${c.value} funded=${c.fundedValue} burned=${c.burned} (labor=${c.laborCost} exp=${c.expenseCost}) status=${c.status} pop=${c.popStart?.slice(0,10)}→${c.popEnd?.slice(0,10)}`);

  const tp = await loadClinBurnTimePhased(orgId, projectId);
  console.log("\n=== TIME-PHASED (project-wide) ===");
  console.log("  ceiling", tp.ceiling, "funded", tp.funded, "burnedToDate", tp.burnedToDate, "runRate", tp.monthlyRunRate);
  console.log("  series months:", tp.series.map((p) => p.month).join(", "));

  // Per-CLIN monthly actuals: approved time + expense grouped by clinId + month
  const clinIds = clins.map((c) => c.id);
  const [te, ex, emps] = await Promise.all([
    prisma.timeEntry.findMany({ where: { orgId, clinId: { in: clinIds }, status: "APPROVED" }, select: { clinId: true, date: true, hours: true, rate: true, userId: true } }),
    prisma.expense.findMany({ where: { orgId, clinId: { in: clinIds }, status: "APPROVED" }, select: { clinId: true, date: true, amount: true } }),
    prisma.employee.findMany({ where: { orgId }, select: { userId: true, costRate: true } }),
  ]);
  const rateByUser = new Map(emps.map((e) => [e.userId, Number(e.costRate)]));
  console.log(`\n=== APPROVED time entries: ${te.length}, expenses: ${ex.length} ===`);
  const byClinMonth = new Map<string, number>();
  const mKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  for (const t of te) { const r = t.rate != null ? Number(t.rate) : (rateByUser.get(t.userId) ?? 0); const k = `${t.clinId}|${mKey(t.date)}`; byClinMonth.set(k, (byClinMonth.get(k) ?? 0) + t.hours * r); }
  for (const e of ex) { const k = `${e.clinId}|${mKey(e.date)}`; byClinMonth.set(k, (byClinMonth.get(k) ?? 0) + Number(e.amount)); }
  const months = [...new Set([...byClinMonth.keys()].map((k) => k.split("|")[1]))].sort();
  console.log("  distinct months with actuals:", months.join(", "));
  for (const c of clins) {
    const cells = months.map((m) => { const v = byClinMonth.get(`${c.id}|${m}`); return v ? `${m}=${Math.round(v)}` : null; }).filter(Boolean);
    if (cells.length) console.log(`  ${c.code}: ${cells.join("  ")}`);
  }

  // Contracts / vendors
  const contracts = await prisma.contract.findMany({ where: { orgId, projectId }, include: { partner: { select: { name: true } } } });
  console.log(`\n=== CONTRACTS/VENDORS (${contracts.length}) ===`);
  for (const c of contracts) console.log(`  ${c.partner?.name} | ${c.title} | agmt=${c.agmtNumber} ceil=${c.value} funded=${c.fundedValue} inv=${c.invoicedValue}`);

  // counts of each register
  const [risks, changes, blockers, deliverables, milestones, staffCount] = await Promise.all([
    prisma.risk.count({ where: { orgId, projectId } }),
    prisma.changeRequest.count({ where: { orgId, projectId } }),
    prisma.blocker.count({ where: { orgId, projectId } }),
    prisma.deliverable.count({ where: { orgId, projectId } }),
    prisma.milestone.count({ where: { orgId, projectId } }),
    prisma.projectMember.count({ where: { projectId } }),
  ]);
  console.log(`\n=== REGISTER COUNTS === risks=${risks} changes=${changes} blockers=${blockers} deliverables=${deliverables} milestones=${milestones} staff=${staffCount}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
