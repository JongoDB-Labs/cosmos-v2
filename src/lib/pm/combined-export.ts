import ExcelJS from "exceljs";
import {
  buildPopulatedTemplate,
  type Tracker,
} from "./template-export";

/**
 * Styled "combined" PM export. Where {@link buildProjectWorkbook} (export.ts)
 * produces a flat, unstyled SheetJS dump, this builds ONE workbook in which each
 * selected tracker contributes its main register sheet WITH the template's
 * formatting — header fills/fonts, column widths, row heights, number formats —
 * and its same-sheet formula columns intact, populated with live Cosmos data.
 *
 * It reuses the full-fidelity populator: {@link buildPopulatedTemplate} returns
 * the same per-tracker .xlsx buffer that "separate" mode zips. We load each
 * buffer with ExcelJS (which preserves cell styles + formulas on read/write),
 * lift out the one main register worksheet, and copy it cell-by-cell into a
 * single combined workbook.
 *
 * What survives: cell values, formulas (as {formula,result} objects), styles
 * (fill/font/border/alignment), number formats, column widths, row heights, and
 * merged ranges. Same-sheet formula columns (Risk Score, schedule variance, …)
 * keep working because they reference their own sheet. What drops vs. separate:
 * charts (ExcelJS doesn't round-trip them) and the multi-tab cascades (burn's
 * 19 tabs, the staffing satellites) — combined carries the single styled
 * register per tracker, not the cross-sheet machinery.
 */

/**
 * For each tracker: the lenient match used to find its MAIN register worksheet
 * inside the populated template, and the tab name it gets in the combined book.
 * `match` is lowercased and compared with `includes` against each sheet's name,
 * so it tolerates the burn tab's emoji prefix ("📊 Burn Summary").
 */
const SHEET_PLAN: Record<Tracker, { match: string; out: string }> = {
  risks: { match: "risk register", out: "Risks" },
  changes: { match: "change log", out: "Change Log" },
  blockers: { match: "blocked items", out: "Blocked Items" },
  schedule: { match: "schedule variance", out: "Schedule" },
  deliverables: { match: "deliverable register", out: "Deliverables" },
  staffing: { match: "personnel register", out: "Staffing" },
  vendors: { match: "vendor register", out: "Vendors" },
  burn: { match: "burn summary", out: "Burn Summary" },
};

/**
 * Locate a worksheet whose (lowercased) name contains `match`. Falls back to the
 * first non-empty worksheet so a single renamed tab never yields an empty sheet.
 */
function findRegisterSheet(
  wb: ExcelJS.Workbook,
  match: string,
): ExcelJS.Worksheet | undefined {
  const lower = match.toLowerCase();
  const hit = wb.worksheets.find((ws) =>
    ws.name.toLowerCase().includes(lower),
  );
  if (hit) return hit;
  return wb.worksheets.find((ws) => ws.rowCount > 0) ?? wb.worksheets[0];
}

/**
 * Copy one worksheet (values + styles + formulas + layout) into `dst`. Cell
 * values are copied via `cell.value`, which for a formula cell is already a
 * `{ formula, result }` object — assigning it round-trips the formula and its
 * cached result. Shared formulas are de-shared to their concrete text (via the
 * `cell.formula` getter) so each destination cell is self-contained.
 */
function copyWorksheet(src: ExcelJS.Worksheet, dst: ExcelJS.Worksheet): void {
  // Column widths / styles — index by 1-based column number.
  src.columns?.forEach((col, i) => {
    if (!col) return;
    const out = dst.getColumn(i + 1);
    if (typeof col.width === "number") out.width = col.width;
    if (col.hidden) out.hidden = true;
  });

  // Sheet-level view niceties (frozen header panes, etc.) — copy if present.
  if (src.views?.length) dst.views = src.views;

  // Cells + row heights. Walk every populated row (includeEmpty keeps blank but
  // styled rows — e.g. banded headers — so the look survives).
  src.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const outRow = dst.getRow(rowNumber);
    if (typeof row.height === "number") outRow.height = row.height;
    if (row.hidden) outRow.hidden = true;

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const outCell = outRow.getCell(colNumber);

      // Value: de-share formulas so each cell stands alone; otherwise copy the
      // raw value (literal, or a {formula,result} master-formula object).
      const v = cell.value;
      if (
        v &&
        typeof v === "object" &&
        "sharedFormula" in v &&
        typeof cell.formula === "string"
      ) {
        outCell.value = {
          formula: cell.formula,
          result: (v as ExcelJS.CellSharedFormulaValue).result,
        } as ExcelJS.CellFormulaValue;
      } else if (v !== null && v !== undefined) {
        outCell.value = v;
      }

      // Style (fill/font/border/alignment/numFmt). Clone so the two workbooks
      // don't alias the same style object.
      if (cell.style) outCell.style = { ...cell.style };
      // numFmt lives inside style, but copy explicitly as a belt-and-braces
      // guard against any style-merge quirk.
      if (cell.numFmt) outCell.numFmt = cell.numFmt;
    });
    outRow.commit();
  });

  // Merged ranges — ExcelJS exposes them on the worksheet model as A1-style
  // strings (e.g. "A1:D1"). Re-apply each on the destination sheet.
  const merges = (src.model?.merges ?? []) as string[];
  for (const range of merges) {
    try {
      dst.mergeCells(range);
    } catch {
      // A malformed/overlapping range shouldn't abort the whole export.
    }
  }
}

/**
 * Build the styled combined workbook: one register sheet per selected tracker,
 * each carrying the template's formatting and live-data formulas. Returns the
 * .xlsx bytes.
 */
export async function buildCombinedWorkbook(
  orgId: string,
  projectId: string,
  projectKey: string,
  trackers: Tracker[],
): Promise<Buffer> {
  const out = new ExcelJS.Workbook();
  out.creator = "Cosmos";
  out.created = new Date();

  for (const tracker of trackers) {
    const { buffer } = await buildPopulatedTemplate(
      tracker,
      orgId,
      projectId,
      projectKey,
    );

    const src = new ExcelJS.Workbook();
    await src.xlsx.load(toArrayBuffer(buffer));

    const plan = SHEET_PLAN[tracker];
    const sheet = findRegisterSheet(src, plan.match);
    if (!sheet) continue;

    // ExcelJS rejects duplicate sheet names; SHEET_PLAN names are unique, but
    // guard anyway.
    const name = out.getWorksheet(plan.out) ? `${plan.out} (${tracker})` : plan.out;
    const dst = out.addWorksheet(name, {
      views: sheet.views?.length ? sheet.views : undefined,
    });
    copyWorksheet(sheet, dst);
  }

  const arrayBuf = await out.xlsx.writeBuffer();
  return Buffer.from(arrayBuf as ArrayBuffer);
}

/** Node Buffer → a tight ArrayBuffer slice (ExcelJS.load wants an ArrayBuffer). */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}
