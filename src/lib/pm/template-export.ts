import path from "path";
import JSZip from "jszip";
import XlsxPopulate from "xlsx-populate";
import { prisma } from "@/lib/db/client";
import { loadMilestonesWithDerived } from "./schedule";
import { loadStaffing } from "./staffing";
import { loadClinsWithBurn } from "./burn";

/**
 * Template-based PM export. Unlike the flat `buildProjectWorkbook` (export.ts),
 * this loads the user's *real* tracker spreadsheets from `templates/` and writes
 * live Cosmos data into the cells whose header text matches each field —
 * preserving every style, formula, data-validation, and (for burn.xlsx) chart.
 *
 * Powered by xlsx-populate: it edits cell VALUES while leaving the rest of the
 * package untouched. Formula cells are re-emitted *without* their cached result,
 * so Excel recomputes Risk Score, variance, COUNTIF/SUMIF dashboards, VLOOKUPs,
 * and chart series the moment the file is opened.
 */

export const TRACKERS = [
  "risks",
  "changes",
  "blockers",
  "schedule",
  "deliverables",
  "staffing",
  "vendors",
  "burn",
] as const;
export type Tracker = (typeof TRACKERS)[number];

const TEMPLATE_DIR = path.join(process.cwd(), "src/lib/pm/templates");

// ── helpers ─────────────────────────────────────────────────────────────────

const fmtDate = (d: Date | string | null | undefined): string => {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};

/** Collapse whitespace/newlines and lowercase, for fuzzy header matching. */
const normHeader = (s: unknown): string =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/–|—/g, "-") // en/em dash → hyphen
    .trim()
    .toLowerCase();

type CellValue = string | number | boolean | null;

/**
 * Definition of a register tracker: which sheet/rows hold the data, and how each
 * column header maps to a Cosmos value. `headerMatch` is matched against the
 * normalized header-row text with startsWith (so "Risk\nScore" matches "risk").
 */
interface ColumnSpec {
  /** Normalized header fragment to locate the column (startsWith match). */
  headerMatch: string;
  /** Pull the cell value for this column from a data row. */
  value: (row: Record<string, unknown>) => CellValue;
}

interface RegisterSpec {
  template: `${string}.xlsx`;
  sheet: string;
  /** 1-based row holding the column titles. */
  headerRow: number;
  /** 1-based first row that holds data/example content (also first write row). */
  firstDataRow: number;
  columns: ColumnSpec[];
}

// ── data loading (mirrors export.ts buildProjectWorkbook) ────────────────────

const branchSel = { programBranch: { select: { code: true } } };

async function loadRegisterRows(
  tracker: Exclude<Tracker, "burn">,
  orgId: string,
  projectId: string,
): Promise<Record<string, unknown>[]> {
  const where = { orgId, projectId };
  // The loaders return concrete typed rows (Risk, StaffRow, …). The populator
  // reads them generically by key, so widen to Record<string, unknown>[].
  const rows = await (async () => {
    switch (tracker) {
      case "risks":
        return prisma.risk.findMany({ where, include: branchSel, orderBy: { code: "asc" } });
      case "changes":
        return prisma.changeRequest.findMany({ where, include: branchSel, orderBy: { code: "asc" } });
      case "blockers":
        return prisma.blocker.findMany({ where, include: branchSel, orderBy: { code: "asc" } });
      case "deliverables":
        return prisma.deliverable.findMany({ where, include: branchSel, orderBy: { code: "asc" } });
      case "schedule":
        return loadMilestonesWithDerived(orgId, projectId);
      case "staffing":
        return loadStaffing(orgId, projectId, { includeCost: true });
      case "vendors":
        return prisma.contract.findMany({
          where,
          include: {
            partner: {
              select: {
                name: true, socioEconomic: true, cageCode: true, perfRating: true,
                ndaOnFile: true, ndaExpiry: true, pocName: true, pocEmail: true,
                type: true,
              },
            },
          },
          orderBy: { value: "desc" },
        });
    }
  })();
  return rows as unknown as Record<string, unknown>[];
}

// ── per-tracker column specs ─────────────────────────────────────────────────
// headerMatch values are normalized fragments (lowercase, whitespace-collapsed)
// taken from each template's real header row. Only columns we have Cosmos data
// for are listed; AUTO/formula columns are intentionally omitted (left to recalc).

const REGISTERS: Record<Exclude<Tracker, "burn">, RegisterSpec> = {
  risks: {
    template: "risks.xlsx",
    sheet: "Risk Register",
    headerRow: 4,
    firstDataRow: 5,
    columns: [
      { headerMatch: "risk id", value: (x) => str(x.code) },
      { headerMatch: "branch", value: (x) => branchCode(x) },
      { headerMatch: "risk title", value: (x) => str(x.title) },
      { headerMatch: "risk description", value: (x) => str(x.description ?? x.mitigation) },
      { headerMatch: "category", value: (x) => str(x.category) },
      { headerMatch: "likelihood", value: (x) => numOrBlank(x.likelihood) },
      { headerMatch: "impact", value: (x) => numOrBlank(x.impact) },
      // I (risk score) & J (risk level) are AUTO formulas — skip.
      { headerMatch: "risk owner", value: (x) => str(x.owner) },
      { headerMatch: "mitigation", value: (x) => str(x.mitigation) },
      { headerMatch: "status", value: (x) => titleCase(str(x.status)) },
      { headerMatch: "notes", value: (x) => str(x.notes) },
    ],
  },
  changes: {
    template: "changes.xlsx",
    sheet: "Change Log",
    headerRow: 3,
    firstDataRow: 4,
    columns: [
      { headerMatch: "change id", value: (x) => str(x.code) },
      { headerMatch: "date submitted", value: (x) => fmtDate(x.submittedDate as Date) },
      { headerMatch: "change title", value: (x) => str(x.title) },
      { headerMatch: "change description", value: (x) => str(x.description) },
      { headerMatch: "change type", value: (x) => titleCase(str(x.type)) },
      { headerMatch: "initiated by", value: (x) => str(x.initiatedBy) },
      { headerMatch: "branch impacted", value: (x) => branchCode(x) },
      { headerMatch: "cost impact", value: (x) => numOrBlank(x.costImpact) },
      { headerMatch: "schedule impact", value: (x) => numOrBlank(x.scheduleDaysImpact) },
      { headerMatch: "scope impact", value: (x) => str(x.scopeImpact) },
      { headerMatch: "decision authority", value: (x) => str(x.decisionAuthority) },
      { headerMatch: "status", value: (x) => titleCase(str(x.status)) },
      { headerMatch: "related risk", value: (x) => str(x.relatedRef) },
      { headerMatch: "notes", value: (x) => str(x.notes) },
    ],
  },
  blockers: {
    template: "blockers.xlsx",
    sheet: "Blocked Items Log",
    headerRow: 3,
    firstDataRow: 5, // R4 is an annotation sub-header; R5 is the "▶ COPY THIS ROW" template.
    columns: [
      { headerMatch: "blocker id", value: (x) => str(x.code) },
      { headerMatch: "branch", value: (x) => branchCode(x) },
      { headerMatch: "blocker type", value: (x) => titleCase(str(x.type)) },
      { headerMatch: "blocker title", value: (x) => str(x.title) },
      { headerMatch: "full description", value: (x) => str(x.description ?? x.whatUnblocks) },
      { headerMatch: "what unblocks", value: (x) => str(x.whatUnblocks) },
      { headerMatch: "blocker owner", value: (x) => str(x.owner) },
      { headerMatch: "related task", value: (x) => str(x.relatedRef) },
      { headerMatch: "escalate to", value: (x) => yesNo(x.escalate) },
      { headerMatch: "status", value: (x) => titleCase(str(x.status)) },
      { headerMatch: "notes", value: (x) => str(x.notes) },
    ],
  },
  schedule: {
    template: "schedule.xlsx",
    sheet: "Schedule Variance Log",
    headerRow: 3,
    firstDataRow: 5, // R4 annotation, R5 template row.
    columns: [
      { headerMatch: "milestone name", value: (x) => str(x.title) },
      { headerMatch: "milestone type", value: (x) => str(x.milestoneType) },
      { headerMatch: "branch", value: (x) => branchCode(x) },
      { headerMatch: "current projected", value: (x) => fmtDate(x.dueDate as Date) },
      // I/J (days variance, direction) are AUTO formulas — skip.
      { headerMatch: "status", value: (x) => statusLabel(str(x.status)) },
      { headerMatch: "root cause", value: (x) => str(x.rootCause) },
      { headerMatch: "downstream milestones", value: (x) => str(x.downstreamImpact) },
      { headerMatch: "escalate to", value: (x) => yesNo(x.scheduleEscalate) },
      { headerMatch: "related cr", value: (x) => str(x.relatedRef) },
      { headerMatch: "notes", value: (x) => str(x.notes) },
    ],
  },
  deliverables: {
    template: "deliverables.xlsx",
    sheet: "Deliverable Register",
    headerRow: 3,
    firstDataRow: 5, // R4 annotation, R5 template row.
    columns: [
      { headerMatch: "deliverable id", value: (x) => str(x.code) },
      { headerMatch: "clin", value: (x) => str(x.clin) },
      { headerMatch: "deliverable title", value: (x) => str(x.title) },
      { headerMatch: "branch owner", value: (x) => str(x.branchOwner) || branchCode(x) },
      { headerMatch: "deliverable owner", value: (x) => str(x.owner) },
      { headerMatch: "baseline due", value: (x) => fmtDate(x.baselineDue as Date) },
      { headerMatch: "actual submission", value: (x) => fmtDate(x.actualSubmission as Date) },
      // K/L (days late, label) and N (review deadline) are AUTO formulas — skip.
      { headerMatch: "current status", value: (x) => statusLabel(str(x.status)) },
      { headerMatch: "clickup reference", value: (x) => str(x.workItemRef) },
      { headerMatch: "context", value: (x) => str(x.notes) },
    ],
  },
  staffing: {
    template: "staffing.xlsx",
    sheet: "Personnel Register",
    headerRow: 3,
    firstDataRow: 5, // R4 annotation, R5 "▶ COPY ROW" template, R6+ examples.
    columns: [
      // Person ID is generated below (P-001…) so VLOOKUP satellite tabs line up.
      { headerMatch: "full name", value: (x) => str(x.name) },
      { headerMatch: "personnel type", value: (x) => personnelType(x) },
      { headerMatch: "role", value: (x) => roleLabel(str(x.role)) },
      { headerMatch: "lcat", value: (x) => str(x.laborCategory) },
      { headerMatch: "branch assigned", value: () => "" },
      { headerMatch: "on contract status", value: (x) => (x.onContract ? "Active" : "Inactive") },
      // L/M/N/O (CAC/Training/Access/NDA) and P (Overall) are VLOOKUP/derived
      // formulas — left intact; the satellite tabs they read are populated by
      // seedStaffingSatellites() so the rollup + Compliance Summary recompute.
      { headerMatch: "clearance level", value: (x) => str(x.clearance) },
      { headerMatch: "notes", value: (x) => str(x.complianceNotes) },
    ],
  },
  vendors: {
    template: "vendors.xlsx",
    sheet: "Vendor Register",
    headerRow: 3,
    firstDataRow: 5, // R4 annotation, R5 "▶ TEMPLATE" row, R6+ examples.
    columns: [
      // Vendor ID generated below (V-001…) to key the Mod Log / Invoice Log seeds.
      { headerMatch: "company name", value: (x) => partnerName(x) },
      { headerMatch: "vendor type", value: (x) => vendorType(x) },
      { headerMatch: "primary agmt type", value: (x) => str(x.agmtType) },
      { headerMatch: "agmt number", value: (x) => str(x.agmtNumber) },
      { headerMatch: "payment terms", value: (x) => str(x.paymentTerms) },
      { headerMatch: "pop start", value: (x) => fmtDate(x.startDate as Date) },
      { headerMatch: "pop end", value: (x) => fmtDate(x.endDate as Date) },
      { headerMatch: "branch supporting", value: () => "" },
      { headerMatch: "poc name", value: (x) => partnerField(x, "pocName") },
      { headerMatch: "poc email", value: (x) => partnerField(x, "pocEmail") },
      { headerMatch: "nda on file", value: (x) => (partnerBool(x, "ndaOnFile") ? "Yes" : "No") },
      { headerMatch: "nda expiry", value: (x) => fmtDate(partnerDate(x, "ndaExpiry")) },
      // O/P/Q (ceiling/funded/invoiced) are MAXIFS/SUMIFS — seeded via Mod/Invoice Log.
      { headerMatch: "agreement status", value: (x) => statusLabel(str(x.status)) },
    ],
  },
};

// ── value coercion helpers ───────────────────────────────────────────────────

function str(v: unknown): string {
  return v == null ? "" : String(v);
}
function numOrBlank(v: unknown): number | "" {
  if (v == null || v === "") return "";
  const n = Number(v);
  return Number.isNaN(n) ? "" : n;
}
function yesNo(v: unknown): string {
  return v ? "Yes" : "No";
}
function branchCode(x: Record<string, unknown>): string {
  const b = x.programBranch as { code?: string } | null | undefined;
  return b?.code ?? "";
}
function titleCase(s: string): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .split(/[\s_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
/** Cosmos enum statuses → human label (e.g. IN_PROGRESS → In Progress). */
function statusLabel(s: string): string {
  return titleCase(s);
}
function roleLabel(s: string): string {
  return titleCase(s);
}
// Compliance enum → the template's expected vocabulary (drives the rollup).
function cacLabel(s: string): string {
  if (s === "active") return "Current";
  if (!s) return "—";
  return titleCase(s);
}
function trainingLabel(s: string): string {
  if (s === "complete") return "Complete";
  if (s === "incomplete") return "Incomplete";
  if (!s) return "—";
  return titleCase(s);
}
function accessLabel(s: string): string {
  if (s === "granted") return "Active";
  if (!s) return "—";
  return titleCase(s);
}
function ndaLabel(s: string): string {
  if (s === "executed") return "Yes";
  if (!s) return "—";
  return titleCase(s);
}
function personnelType(x: Record<string, unknown>): string {
  // Cosmos tracks employment type as SALARY/HOURLY; the tracker's "Personnel
  // Type" uses the govcon taxonomy (FTE / 1099 / Subcontractor / …). Map the
  // two values we have; salaried → FTE, hourly → 1099 (hourly engagements here
  // are 1099 contractors).
  const et = str(x.employmentType).toUpperCase();
  if (et === "SALARY") return "FTE";
  if (et === "HOURLY") return "1099";
  return et ? titleCase(et) : "FTE";
}
function partnerName(x: Record<string, unknown>): string {
  const p = x.partner as { name?: string } | null | undefined;
  return p?.name ?? "";
}
function vendorType(x: Record<string, unknown>): string {
  const p = x.partner as { type?: string } | null | undefined;
  return titleCase(p?.type ?? "") || "Subcontractor";
}
function partnerField(x: Record<string, unknown>, key: string): string {
  const p = x.partner as Record<string, unknown> | null | undefined;
  return p ? str(p[key]) : "";
}
function partnerBool(x: Record<string, unknown>, key: string): boolean {
  const p = x.partner as Record<string, unknown> | null | undefined;
  return !!(p && p[key]);
}
function partnerDate(x: Record<string, unknown>, key: string): Date | string | null {
  const p = x.partner as Record<string, unknown> | null | undefined;
  return p ? (p[key] as Date | string | null) : null;
}

// ── generic register populator ───────────────────────────────────────────────

/** Build a header-text → column-index (1-based) map by scanning the header row. */
function mapHeaderColumns(
  sheet: { cell: (r: number, c: number) => { value: () => unknown } },
  headerRow: number,
  maxCol: number,
): { norm: string; col: number }[] {
  const out: { norm: string; col: number }[] = [];
  for (let c = 1; c <= maxCol; c++) {
    const v = sheet.cell(headerRow, c).value();
    const norm = normHeader(v);
    if (norm) out.push({ norm, col: c });
  }
  return out;
}

/** Resolve a ColumnSpec to its sheet column, first header that startsWith match. */
function resolveColumn(
  headers: { norm: string; col: number }[],
  headerMatch: string,
): number | null {
  const hit = headers.find((h) => h.norm.startsWith(headerMatch));
  return hit ? hit.col : null;
}

const usedRange = (sheet: { usedRange: () => { endCell: () => { columnNumber: () => number; rowNumber: () => number } } | null }) =>
  sheet.usedRange();

/**
 * Populate one register tracker template with live rows. Clears the template's
 * example/placeholder rows (from firstDataRow down to the end of used data) and
 * writes Cosmos rows starting at firstDataRow. Formula columns aren't touched —
 * but to extend per-row formulas (Risk Score, variance…) DOWN to every new data
 * row, we copy each formula cell's formula from the captured first example row.
 */
async function populateRegister(
  spec: RegisterSpec,
  rows: Record<string, unknown>[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wb: any,
): Promise<void> {
  const sheet = wb.sheet(spec.sheet);
  if (!sheet) throw new Error(`sheet "${spec.sheet}" not found`);

  const used = usedRange(sheet);
  const maxCol = used ? used.endCell().columnNumber() : 30;
  const lastUsedRow = used ? used.endCell().rowNumber() : spec.firstDataRow;

  const headers = mapHeaderColumns(sheet, spec.headerRow, maxCol);

  // 1) Capture the formula columns from the first example row (so we can copy
  //    them down to every new data row). A column is "formula" if its cell in
  //    the first data row carries a formula.
  const formulaByCol = new Map<number, string>();
  for (let c = 1; c <= maxCol; c++) {
    const f = sheet.cell(spec.firstDataRow, c).formula();
    if (f) formulaByCol.set(c, f);
  }

  // 2) Resolve each spec column to a sheet column index.
  const resolved = spec.columns
    .map((col) => ({ col, idx: resolveColumn(headers, col.headerMatch) }))
    .filter((x): x is { col: ColumnSpec; idx: number } => x.idx != null);

  // 3) Clear every example/placeholder cell from firstDataRow..lastUsedRow,
  //    across all columns in range (values only; styles stay).
  for (let row = spec.firstDataRow; row <= lastUsedRow; row++) {
    for (let c = 1; c <= maxCol; c++) {
      const cell = sheet.cell(row, c);
      if (cell.formula()) cell.clear(); // drop example formulas; re-added below
      else if (cell.value() !== undefined) cell.value(undefined);
    }
  }

  // 4) Write live rows.
  rows.forEach((dataRow, i) => {
    const row = spec.firstDataRow + i;
    for (const { col, idx } of resolved) {
      const v = col.value(dataRow);
      if (v !== "" && v != null) sheet.cell(row, idx).value(v as CellValue);
    }
    // Re-apply per-row formulas, shifting the row reference from the captured
    // example row to this row.
    for (const [c, formula] of formulaByCol) {
      // Skip formula columns we explicitly overwrote with a literal value.
      if (resolved.some((rcol) => rcol.idx === c)) continue;
      const shifted = shiftFormulaRows(formula, spec.firstDataRow, row);
      sheet.cell(row, c).formula(shifted);
    }
  });

  // 5) Special post-processing per tracker.
  if (spec.template === "staffing.xlsx") {
    writeIdColumn(sheet, spec, rows.length, "P");
    seedStaffingSatellites(wb, rows);
  }
  if (spec.template === "vendors.xlsx") {
    writeIdColumn(sheet, spec, rows.length, "V");
    seedVendorLogs(wb, rows);
  }
}

/**
 * Shift every relative row reference in a formula by (toRow - fromRow). Only
 * un-anchored row numbers (no `$` before the digits) are moved; absolute rows
 * ($5) and sheet/table names are left intact. Good enough for the simple
 * intra-row formulas these templates use (=G5*H5, =J5-TODAY(), =IF(...)).
 */
function shiftFormulaRows(formula: string, fromRow: number, toRow: number): string {
  const delta = toRow - fromRow;
  if (delta === 0) return formula;
  // Match a column letter group followed by a row number, not preceded by $ on
  // the row, and not part of a longer token. Capture optional $col.
  return formula.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)/g, (m, col, rowAbs, rowNum) => {
    if (rowAbs === "$") return m; // absolute row — leave
    const n = parseInt(rowNum, 10);
    // Only shift references that point at the example data row (fromRow). This
    // keeps header/range anchors (e.g. J:J style are letter-only, unaffected).
    if (n !== fromRow) return m;
    return `${col}${rowAbs}${n + delta}`;
  });
}

/** Write generated IDs (P-001 / V-001…) into column `colLetter`, rows down. */
function writeIdColumn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sheet: any,
  spec: RegisterSpec,
  count: number,
  prefix: string,
): void {
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${String(i + 1).padStart(3, "0")}`;
    sheet.cell(`A${spec.firstDataRow + i}`).value(id); // ID is column A on both registers
  }
}

// ── vendors: seed Mod Log + Invoice Log so register formulas resolve ─────────
/**
 * The Vendor Register's Ceiling/Funded/Invoiced columns are MAXIFS/SUMIFS over
 * the Mod Log and Invoice Log tabs, keyed on Vendor ID. Cosmos has no mod
 * history, so we synthesize one "award" Mod Log row per vendor (ceiling+funded)
 * and one Invoice Log row (invoiced, status=Approved) — making the register's
 * derived financials resolve to Cosmos's value/fundedValue/invoicedValue.
 */
function seedVendorLogs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wb: any,
  rows: Record<string, unknown>[],
): void {
  const modSheet = wb.sheet("Mod Log");
  const invSheet = wb.sheet("Invoice Log");
  if (!modSheet || !invSheet) return;

  // Mod Log header is R3; data R4+. Columns: A VendorID, B Company, C Agmt#,
  // D Mod#, E EffDate, F Categories, G Desc, J Ceiling To, M Funded To.
  const modHeaders = mapHeaderColumns(modSheet, 3, 20);
  const modCol = {
    id: 1,
    company: resolveColumn(modHeaders, "company name") ?? 2,
    agmt: resolveColumn(modHeaders, "agmt number") ?? 3,
    modNum: resolveColumn(modHeaders, "mod number") ?? 4,
    eff: resolveColumn(modHeaders, "effective date") ?? 5,
    cat: resolveColumn(modHeaders, "mod categories") ?? 6,
    desc: resolveColumn(modHeaders, "description") ?? 7,
    ceilTo: resolveColumn(modHeaders, "ceiling to") ?? 10, // J
    fundTo: resolveColumn(modHeaders, "funded to") ?? 13, // M
  };
  clearDataRows(modSheet, 4, 20);
  rows.forEach((row, i) => {
    const rownum = 4 + i;
    const id = `V-${String(i + 1).padStart(3, "0")}`;
    modSheet.cell(rownum, modCol.id).value(id);
    modSheet.cell(rownum, modCol.company).value(partnerName(row));
    modSheet.cell(rownum, modCol.agmt).value(str(row.agmtNumber));
    modSheet.cell(rownum, modCol.modNum).value("Mod-000");
    modSheet.cell(rownum, modCol.eff).value(fmtDate(row.startDate as Date));
    modSheet.cell(rownum, modCol.cat).value("Award");
    modSheet.cell(rownum, modCol.desc).value("Initial award (synthesized from Cosmos contract).");
    const ceil = numOrBlank(row.value);
    const fund = numOrBlank(row.fundedValue);
    if (ceil !== "") modSheet.cell(rownum, modCol.ceilTo).value(ceil);
    if (fund !== "") modSheet.cell(rownum, modCol.fundTo).value(fund);
  });

  // Invoice Log header is R3; data R4+. Columns: A VendorID, F Amount, G Status.
  const invHeaders = mapHeaderColumns(invSheet, 3, 20);
  const invCol = {
    id: 1,
    company: resolveColumn(invHeaders, "company name") ?? 2,
    amount: resolveColumn(invHeaders, "invoice amount") ?? resolveColumn(invHeaders, "amount") ?? 6,
    status: resolveColumn(invHeaders, "status") ?? resolveColumn(invHeaders, "approval") ?? 7,
  };
  clearDataRows(invSheet, 4, 20);
  let invRow = 4;
  rows.forEach((row, i) => {
    const invoiced = numOrBlank(row.invoicedValue);
    if (invoiced === "" || invoiced === 0) return;
    const id = `V-${String(i + 1).padStart(3, "0")}`;
    invSheet.cell(invRow, invCol.id).value(id);
    if (invCol.company) invSheet.cell(invRow, invCol.company).value(partnerName(row));
    invSheet.cell(invRow, invCol.amount).value(invoiced);
    invSheet.cell(invRow, invCol.status).value("Approved");
    invRow++;
  });
}

/** Blank values + formulas in rows [from..end-of-used] across cols 1..maxCol. */
function clearDataRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sheet: any,
  from: number,
  maxCol: number,
): void {
  const used = sheet.usedRange();
  const last = used ? used.endCell().rowNumber() : from;
  for (let row = from; row <= last; row++) {
    for (let c = 1; c <= maxCol; c++) {
      const cell = sheet.cell(row, c);
      if (cell.formula()) cell.clear();
      else if (cell.value() !== undefined) cell.value(undefined);
    }
  }
}

// ── staffing: populate satellite compliance tabs ─────────────────────────────
/**
 * The Personnel Register's CAC/Training/Access/NDA columns VLOOKUP into four
 * satellite tabs (col D = status), and the Compliance Summary COUNTIFs those
 * same D columns. We populate each satellite tab's Person ID / Name / status (D)
 * for our people — using the vocabulary the rollup expects — and clear the
 * template's example rows so stale fictional personnel don't skew the counts.
 * Data rows start at R6 (R4 annotation, R5 placeholder) on every satellite tab.
 */
function seedStaffingSatellites(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wb: any,
  rows: Record<string, unknown>[],
): void {
  const SAT_FIRST = 6;
  const tabs: { name: string; status: (x: Record<string, unknown>) => string }[] = [
    { name: "CAC & Identity", status: (x) => cacLabel(str(x.cacStatus)) },
    { name: "Annual Training", status: (x) => trainingLabel(str(x.trainingStatus)) },
    { name: "System Access", status: (x) => accessLabel(str(x.accessStatus)) },
    { name: "NDA & Agreements", status: (x) => ndaLabel(str(x.ndaStatus)) },
  ];
  for (const { name, status } of tabs) {
    const sheet = wb.sheet(name);
    if (!sheet) continue;
    const used = sheet.usedRange();
    const maxCol = used ? used.endCell().columnNumber() : 13;
    clearDataRows(sheet, SAT_FIRST, maxCol);
    rows.forEach((row, i) => {
      const rownum = SAT_FIRST + i;
      sheet.cell(rownum, 1).value(`P-${String(i + 1).padStart(3, "0")}`); // A Person ID
      sheet.cell(rownum, 2).value(str(row.name)); // B Full Name
      sheet.cell(rownum, 4).value(status(row)); // D status (drives VLOOKUP + Summary)
    });
  }
}

// ── burn populator ────────────────────────────────────────────────────────────

const MONTH_TAB_BY_NAME: Record<number, string> = {
  0: "Jan", 1: "Feb-E", 2: "Mar", 3: "Apr", 4: "May", 5: "Jun",
  6: "Jul", 7: "Aug", 8: "Sep", 9: "Oct", 10: "Nov", 11: "Dec",
};

interface BurnPopulationReport {
  setupClins: number;
  monthsPopulated: string[];
  monthsDropped: string[];
}

/**
 * Populate burn.xlsx so its cascade + 11 charts recompute from Cosmos data.
 * Populates:
 *   • ⚙️ Setup — CLIN master (code, description, ceiling, funded) from
 *     loadClinsWithBurn. Ceiling/Funded cells normally pull from Mod Tracker;
 *     we overwrite them with literal Cosmos values (the Mod Tracker is left
 *     as the template — Cosmos has no mod history).
 *   • 12 monthly tabs — Prime Actuals (col E) per CLIN row, from approved
 *     TimeEntry + Expense grouped by clinId + calendar month. CPFF Forecast
 *     cells (cross-sheet links to the unpopulated Labor Forecast) are replaced
 *     with the actual so Variance reads 0 rather than #REF-ish noise.
 * Left as template: Mod Tracker, Labor Forecast (no clean Cosmos source).
 */
async function populateBurn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wb: any,
  orgId: string,
  projectId: string,
): Promise<BurnPopulationReport> {
  const clins = await loadClinsWithBurn(orgId, projectId);

  // Per-CLIN monthly actuals (approved time labor + expenses), keyed clinId|YYYY-MM.
  const clinIds = clins.map((c) => c.id);
  const [timeEntries, expenses, employees] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { orgId, clinId: { in: clinIds }, status: "APPROVED" },
      select: { clinId: true, date: true, hours: true, rate: true, userId: true },
    }),
    prisma.expense.findMany({
      where: { orgId, clinId: { in: clinIds }, status: "APPROVED" },
      select: { clinId: true, date: true, amount: true },
    }),
    prisma.employee.findMany({ where: { orgId }, select: { userId: true, costRate: true } }),
  ]);
  const rateByUser = new Map(employees.map((e) => [e.userId, Number(e.costRate)]));
  const mKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  // actual[clinId][YYYY-MM] = $
  const actual = new Map<string, Map<string, number>>();
  const noteActual = (clinId: string, key: string, amt: number) => {
    if (!actual.has(clinId)) actual.set(clinId, new Map());
    const m = actual.get(clinId)!;
    m.set(key, (m.get(key) ?? 0) + amt);
  };
  for (const t of timeEntries) {
    if (!t.clinId) continue;
    const rate = t.rate != null ? Number(t.rate) : (rateByUser.get(t.userId) ?? 0);
    noteActual(t.clinId, mKey(t.date), t.hours * rate);
  }
  for (const e of expenses) {
    if (!e.clinId) continue;
    noteActual(e.clinId, mKey(e.date), Number(e.amount));
  }

  // ── ⚙️ Setup CLIN master ──
  const setup = wb.sheet("⚙️ Setup");
  const SETUP_FIRST = 15; // B15 = first CLIN
  const SETUP_LAST = 23; // B23 = last CLIN slot (template has 9)
  // Clear the 9 template CLIN rows' B..F (code/desc/type/ceiling/funded) — and
  // the "Sub?"/notes G/H — then rewrite for our CLINs. Row map: B,C,D,E,F,G,H = 2..8.
  for (let row = SETUP_FIRST; row <= SETUP_LAST; row++) {
    for (let c = 2; c <= 8; c++) {
      const cell = setup.cell(row, c);
      if (cell.formula()) cell.clear();
      else if (cell.value() !== undefined) cell.value(undefined);
    }
  }
  clins.slice(0, SETUP_LAST - SETUP_FIRST + 1).forEach((c, i) => {
    const row = SETUP_FIRST + i;
    setup.cell(row, 2).value(c.code); // B CLIN
    setup.cell(row, 3).value(c.title); // C Description
    setup.cell(row, 4).value(""); // D Type (Cosmos has no CLIN funding type)
    setup.cell(row, 5).value(c.value); // E Current Ceiling (literal; was Mod Tracker link)
    setup.cell(row, 6).value(c.fundedValue); // F Current Funded (literal)
    setup.cell(row, 7).value("No"); // G Sub?
  });
  // E24/F24 TOTAL remain =SUM(E15:E23)/=SUM(F15:F23) — recompute over our values.

  // ── monthly tabs: Prime Actuals (col E) per CLIN row ──
  // Each monthly tab has CLIN rows 7..15 mirroring Setup rows 15..23 (B7='Setup'!B15).
  // We write Cosmos actuals into the rows matching our populated CLINs (first N).
  const MONTH_FIRST_ROW = 7;
  const monthsPopulated = new Set<string>();
  const monthsDropped = new Set<string>();
  // Collect the union of months across all CLINs.
  const allMonths = new Set<string>();
  for (const m of actual.values()) for (const k of m.keys()) allMonths.add(k);

  // First, zero out the Prime Actuals (E) + clear CPFF forecast links on every
  // monthly tab, so leftover template example numbers don't pollute totals.
  for (const tab of Object.values(MONTH_TAB_BY_NAME)) {
    const sheet = wb.sheet(`📅 ${tab}`);
    if (!sheet) continue;
    for (let row = MONTH_FIRST_ROW; row <= MONTH_FIRST_ROW + 8; row++) {
      // E = Prime Actuals (input). Clear to blank.
      const e = sheet.cell(row, 5);
      if (e.formula()) e.clear();
      else if (e.value() !== undefined) e.value(undefined);
      // H = Forecast. If it's a cross-sheet link (to Labor Forecast), replace
      // with 0 so Variance doesn't reference an unpopulated tab; if it's a
      // literal example, also zero it. (We set per-CLIN forecast below.)
      const h = sheet.cell(row, 8);
      if (h.formula()) h.clear();
      h.value(0);
    }
  }

  // Now write our CLIN actuals into the matching rows + months.
  for (const key of allMonths) {
    const mm = Number(key.split("-")[1]);
    const monthIdx = mm - 1;
    const tabName = MONTH_TAB_BY_NAME[monthIdx];
    const sheet = wb.sheet(`📅 ${tabName}`);
    if (!sheet) {
      monthsDropped.add(key);
      continue;
    }
    let wroteAny = false;
    clins.slice(0, 9).forEach((c, i) => {
      const amt = actual.get(c.id)?.get(key);
      if (amt == null) return;
      const row = MONTH_FIRST_ROW + i;
      const rounded = Math.round(amt * 100) / 100;
      sheet.cell(row, 5).value(rounded); // E Prime Actuals
      sheet.cell(row, 8).value(rounded); // H Forecast = actual (variance → 0)
      wroteAny = true;
    });
    if (wroteAny) monthsPopulated.add(`${key}→${tabName}`);
  }

  return {
    setupClins: Math.min(clins.length, SETUP_LAST - SETUP_FIRST + 1),
    monthsPopulated: [...monthsPopulated].sort(),
    monthsDropped: [...monthsDropped].sort(),
  };
}

// ── public API ────────────────────────────────────────────────────────────────

export interface PopulateResult {
  buffer: Buffer;
  filename: string;
  /** Burn-only detail; undefined for register trackers. */
  burnReport?: BurnPopulationReport;
}

/**
 * Load a tracker's template, populate it with the project's live Cosmos data,
 * and return the .xlsx buffer. Styles, formulas, validations, and charts are
 * preserved; formula cells recompute on open.
 */
export async function buildPopulatedTemplate(
  tracker: Tracker,
  orgId: string,
  projectId: string,
  projectKey: string,
): Promise<PopulateResult> {
  const templateName = tracker === "burn" ? "burn.xlsx" : REGISTERS[tracker].template;
  const wb = await XlsxPopulate.fromFileAsync(path.join(TEMPLATE_DIR, templateName));

  let burnReport: BurnPopulationReport | undefined;
  if (tracker === "burn") {
    burnReport = await populateBurn(wb, orgId, projectId);
  } else {
    const spec = REGISTERS[tracker];
    const rows = await loadRegisterRows(tracker, orgId, projectId);
    await populateRegister(spec, rows, wb);
  }

  const out = (await wb.outputAsync()) as Buffer;
  const recalced = await forceRecalcOnLoad(out);
  return {
    buffer: recalced,
    filename: `${projectKey}-${tracker}.xlsx`,
    burnReport,
  };
}

/**
 * Set `fullCalcOnLoad="1"` on the workbook's `<calcPr>` so Excel fully
 * recalculates every formula — and refreshes chart caches — the instant the
 * file opens. xlsx-populate already drops cached formula values, but the burn
 * charts embed their own `<c:numCache>`; this guarantees they repaint from the
 * live Cosmos numbers rather than the template's example data. Surgical
 * zip-edit of xl/workbook.xml only; everything else is byte-identical.
 */
async function forceRecalcOnLoad(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("xl/workbook.xml");
  if (!entry) return buffer;
  let xml = await entry.async("string");
  if (/<calcPr\b[^>]*\bfullCalcOnLoad=/.test(xml)) {
    // already present — leave as-is
  } else if (/<calcPr\b[^>]*\/>/.test(xml)) {
    xml = xml.replace(/<calcPr\b([^>]*)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
  } else if (/<calcPr\b[^>]*>/.test(xml)) {
    xml = xml.replace(/<calcPr\b([^>]*)>/, '<calcPr$1 fullCalcOnLoad="1">');
  } else {
    // No calcPr at all — inject one right after the sheets close tag.
    xml = xml.replace(/<\/sheets>/, '</sheets><calcPr fullCalcOnLoad="1"/>');
  }
  zip.file("xl/workbook.xml", xml);
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}
