import * as XLSX from "xlsx";
import { prisma } from "@/lib/db/client";
import { loadMilestonesWithDerived } from "./schedule";
import { loadStaffing } from "./staffing";
import { loadClinsWithBurn } from "./burn";

/**
 * Build a project workbook — one sheet per PM register, mirroring the original
 * tracker spreadsheets. Reuses the same derivation loaders the UI uses so the
 * exported numbers match the dashboard exactly.
 */
function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}
const num = (d: { toString(): string } | number | null | undefined): number | "" =>
  d == null ? "" : Number(d);

const branchSel = { programBranch: { select: { code: true } } };

export async function buildProjectWorkbook(orgId: string, projectId: string): Promise<Buffer> {
  const where = { orgId, projectId };
  const [risks, changes, blockers, deliverables, milestones, vendors, staffing, clins] =
    await Promise.all([
      prisma.risk.findMany({ where, include: branchSel, orderBy: { code: "asc" } }),
      prisma.changeRequest.findMany({ where, include: branchSel, orderBy: { code: "asc" } }),
      prisma.blocker.findMany({ where, include: branchSel, orderBy: { code: "asc" } }),
      prisma.deliverable.findMany({ where, include: branchSel, orderBy: { code: "asc" } }),
      loadMilestonesWithDerived(orgId, projectId),
      prisma.contract.findMany({
        where,
        include: { partner: { select: { name: true, socioEconomic: true, cageCode: true, perfRating: true } } },
        orderBy: { value: "desc" },
      }),
      loadStaffing(orgId, projectId, { includeCost: true }),
      loadClinsWithBurn(orgId, projectId),
    ]);

  const wb = XLSX.utils.book_new();
  const addSheet = (name: string, rows: Record<string, unknown>[]) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "(no rows)": "" }]);
    XLSX.utils.book_append_sheet(wb, ws, name);
  };

  addSheet("Risks", risks.map((r) => ({
    ID: r.code, Title: r.title, Branch: r.programBranch?.code ?? "", Category: r.category ?? "",
    Likelihood: r.likelihood, Impact: r.impact, Score: r.score, Level: r.level,
    Owner: r.owner ?? "", Status: r.status, Mitigation: r.mitigation ?? "",
  })));
  addSheet("Change Log", changes.map((c) => ({
    ID: c.code, Title: c.title, Type: c.type, Branch: c.programBranch?.code ?? "",
    "Cost Impact": num(c.costImpact), "Schedule Days": c.scheduleDaysImpact ?? "",
    "Initiated By": c.initiatedBy ?? "", "Decision Authority": c.decisionAuthority ?? "", Status: c.status,
  })));
  addSheet("Blocked Items", blockers.map((b) => ({
    ID: b.code, Title: b.title, Type: b.type, Branch: b.programBranch?.code ?? "",
    Owner: b.owner ?? "", "What Unblocks": b.whatUnblocks ?? "", Escalated: b.escalate ? "Yes" : "",
    Status: b.status,
  })));
  addSheet("Schedule", milestones.map((m) => ({
    Title: m.title, Branch: m.programBranch?.code ?? "", Baseline: fmtDate(m.baselineDate),
    Projected: fmtDate(m.dueDate), Status: m.status, "Progress %": m.completionPercent ?? "",
    "Root Cause": m.rootCause ?? "", Escalate: m.scheduleEscalate ? "Yes" : "",
  })));
  addSheet("Deliverables", deliverables.map((d) => ({
    ID: d.code, Title: d.title, CLIN: d.clin ?? "", Branch: d.programBranch?.code ?? "",
    "Baseline Due": fmtDate(d.baselineDue), "Actual Submission": fmtDate(d.actualSubmission),
    Status: d.status, Owner: d.owner ?? "",
  })));
  addSheet("Vendors", vendors.map((v) => ({
    Vendor: v.partner?.name ?? "", "Socio-Economic": v.partner?.socioEconomic ?? "",
    CAGE: v.partner?.cageCode ?? "", Title: v.title, Committed: num(v.value),
    Currency: v.currency, Status: v.status, "PoP Start": fmtDate(v.startDate), "PoP End": fmtDate(v.endDate),
  })));
  addSheet("Staffing", staffing.map((s) => ({
    Person: s.name, Role: s.role, "Labor Category": s.laborCategory ?? "",
    Clearance: s.clearance ?? "", "Allocation %": s.allocationPercent ?? "", "Cost Rate": s.costRate ?? "",
  })));
  addSheet("CLIN Burn", clins.map((c) => ({
    CLIN: c.code, Title: c.title, Funded: c.fundedValue, Ceiling: c.value, Burned: c.burned,
    Remaining: c.remaining, "% Consumed": c.percentConsumed ?? "",
  })));

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
