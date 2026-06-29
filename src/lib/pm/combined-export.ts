import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
  buildPopulatedTemplate,
  type Tracker,
} from "./template-export";

/**
 * Full-fidelity "combined" PM export. Where {@link buildProjectWorkbook}
 * (export.ts) produces a flat, unstyled SheetJS dump and the *separate* mode
 * ships one .xlsx per tracker, this merges EVERY tab of every selected tracker
 * into ONE workbook — Instructions sheets, data registers, Summary dashboards,
 * and burn's full 19-tab cascade — preserving styles, number formats, merges,
 * column widths, row heights, frozen panes, AND working cross-sheet formulas so
 * the Summary COUNTIF/SUMIF rollups and the burn cascade recompute on open.
 *
 * It reuses the full-fidelity populator: {@link buildPopulatedTemplate} returns
 * the same per-tracker .xlsx buffer that "separate" mode emits. We load each
 * buffer with ExcelJS, prefix every sheet name with a short tracker code to keep
 * names globally unique (and ≤31 chars), copy each sheet cell-by-cell, and
 * rewrite every cross-sheet formula reference to point at the prefixed names.
 * Because a tracker's formulas only ever reference that tracker's own sheets,
 * each rename map is self-contained — there is no cross-tracker ambiguity.
 *
 * What survives: cell values, formulas (de-shared to concrete text, cached
 * results dropped so Excel recomputes), styles (fill/font/border/alignment),
 * number formats, column widths, row heights, hidden flags, frozen-pane views,
 * merged ranges, and tab colors. What does NOT survive: burn's embedded charts —
 * ExcelJS does not round-trip chart parts, and re-injecting them via raw OOXML
 * surgery could not be corruption-validated in this environment (no
 * soffice/libreoffice on PATH), so the safe choice is a clean chartless file.
 */

/** Short, stable per-tracker code used as the sheet-name prefix. */
const TRACKER_CODE: Record<Tracker, string> = {
  risks: "RSK",
  changes: "CHG",
  blockers: "BLK",
  schedule: "SCH",
  deliverables: "DLV",
  staffing: "STF",
  vendors: "VEN",
  burn: "BRN",
};

/** Excel hard limit on worksheet-name length. */
const MAX_SHEET_NAME = 31;
/** Characters Excel forbids in a worksheet name. */
const FORBIDDEN_SHEET_CHARS = /[:\\/?*[\]]/g;
/** Separator between the tracker code and the original sheet name. */
const SEP = " · ";

/**
 * Build a unique, Excel-legal sheet name from a tracker code + original name.
 * Strips forbidden chars, prefixes `"<CODE> · "`, truncates the original part to
 * fit the 31-char limit, and disambiguates collisions by trimming a char and
 * appending an incrementing digit. `taken` accumulates names already in use
 * across the whole combined workbook so global uniqueness holds.
 */
function makeSheetName(code: string, original: string, taken: Set<string>): string {
  const cleanOriginal = original.replace(FORBIDDEN_SHEET_CHARS, " ").replace(/\s+/g, " ").trim();
  const prefix = `${code}${SEP}`;
  const room = MAX_SHEET_NAME - prefix.length;
  const base = `${prefix}${cleanOriginal.slice(0, room)}`.trim();

  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  // Collision: append a digit, shrinking the original tail to stay within 31.
  for (let n = 2; n < 1000; n++) {
    const suffix = String(n);
    const keep = MAX_SHEET_NAME - prefix.length - suffix.length;
    const candidate = `${prefix}${cleanOriginal.slice(0, Math.max(0, keep))}${suffix}`.trim();
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  // Pathological fallback — should never be reached for 48 sheets.
  const fallback = `${prefix}${Date.now() % 100000}`.slice(0, MAX_SHEET_NAME);
  taken.add(fallback);
  return fallback;
}

/**
 * Rewrite cross-sheet references in one formula using `renameMap` (old sheet
 * name → new prefixed name). Sheet refs appear quoted (`'Old Name'!`) or
 * unquoted (`OldName!`). We replace WHOLE sheet-name tokens immediately followed
 * by `!`, longest original-name first (so "Summary" never clobbers a leading
 * "Summary Dashboard"), and always emit the new name quoted. Only references to
 * this tracker's own sheets exist in its formulas, so the map is complete and
 * substrings inside other tokens/strings are never touched.
 *
 * Replacement is done with literal `split`/`join` — NOT regex — because several
 * sheet names contain emoji (e.g. "📅 Apr", a UTF-16 surrogate pair). A global
 * RegExp replace can split a surrogate when two such tokens sit adjacent in one
 * formula, mojibake-ing the output; literal `split` is surrogate-safe.
 */
function rewriteFormula(formula: string, renameMap: Map<string, string>): string {
  // Longest names first to avoid prefix-collision mis-replacement (replace the
  // longer "'Summary Dashboard'!" before the shorter "'Summary'!").
  const olds = [...renameMap.keys()].sort((a, b) => b.length - a.length);
  let out = formula;
  for (const oldName of olds) {
    const newName = renameMap.get(oldName)!;
    // Excel doubles a literal apostrophe inside a quoted sheet name.
    const quotedNew = `'${newName.replace(/'/g, "''")}'!`;

    // 1) Quoted form: '<oldName>'!  — the form these templates always emit for
    //    names with spaces/emoji/punctuation. Literal, surrogate-safe.
    const quotedOld = `'${oldName.replace(/'/g, "''")}'!`;
    if (out.includes(quotedOld)) out = out.split(quotedOld).join(quotedNew);

    // 2) Unquoted form: <oldName>!  — only when the name is a bare identifier
    //    (so it can legally appear unquoted). Guard the left side against
    //    matching a substring of a longer token or an already-quoted hit.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(oldName)) {
      const escOldBare = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(
        new RegExp(`(^|[^A-Za-z0-9_'])${escOldBare}!`, "g"),
        `$1${quotedNew}`,
      );
    }
  }
  return out;
}

/** Per-sheet record of the formula written to each cell, keyed by A1 address. */
type FormulaLog = Map<string, Map<string, string>>;

/**
 * Copy one worksheet (values + styles + formulas + layout) from `src` into the
 * already-created `dst`, rewriting cross-sheet formula refs via `renameMap`.
 * Every formula written is recorded in `formulaLog` under the destination sheet
 * name so a post-write pass can repair ExcelJS's rare surrogate-at-chunk-
 * boundary corruption (see {@link repairSurrogateCorruption}).
 */
function copyWorksheet(
  src: ExcelJS.Worksheet,
  dst: ExcelJS.Worksheet,
  renameMap: Map<string, string>,
  formulaLog: FormulaLog,
): void {
  const sheetFormulas = new Map<string, string>();
  formulaLog.set(dst.name, sheetFormulas);

  // Column widths / hidden flags / styles — index by 1-based column number.
  src.columns?.forEach((col, i) => {
    if (!col) return;
    const out = dst.getColumn(i + 1);
    if (typeof col.width === "number") out.width = col.width;
    if (col.hidden) out.hidden = true;
    if (col.style) out.style = { ...col.style };
  });

  // Sheet-level view niceties (frozen header panes, zoom, gridline toggle, …).
  if (src.views?.length) dst.views = src.views;

  // Tab color, if any.
  const tabColor = src.properties?.tabColor;
  if (tabColor) dst.properties.tabColor = tabColor;

  // Cells + row heights. includeEmpty keeps blank-but-styled rows (banded
  // headers) so the look survives.
  src.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const outRow = dst.getRow(rowNumber);
    if (typeof row.height === "number") outRow.height = row.height;
    if (row.hidden) outRow.hidden = true;

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const outCell = outRow.getCell(colNumber);
      const v = cell.value;

      // Formula cell (shared or master): re-emit the concrete formula text with
      // cross-sheet refs rewritten, and DROP the cached result so Excel
      // recomputes on open. `cell.formula` de-shares to concrete text.
      const isFormula =
        v != null &&
        typeof v === "object" &&
        ("formula" in v || "sharedFormula" in v) &&
        typeof cell.formula === "string";

      if (isFormula) {
        const rewritten = rewriteFormula(cell.formula, renameMap);
        outCell.value = { formula: rewritten } as ExcelJS.CellFormulaValue;
        sheetFormulas.set(outCell.address, rewritten);
      } else if (v !== null && v !== undefined) {
        outCell.value = v;
      }

      // Style (fill/font/border/alignment/numFmt). Clone so the workbooks don't
      // alias the same style object.
      if (cell.style) outCell.style = { ...cell.style };
      if (cell.numFmt) outCell.numFmt = cell.numFmt;
    });
    outRow.commit();
  });

  // Merged ranges — A1-style strings on the worksheet model (e.g. "A1:D1").
  const merges = (src.model?.merges ?? []) as string[];
  for (const range of merges) {
    try {
      dst.mergeCells(range);
    } catch {
      // A malformed/overlapping range shouldn't abort the whole export.
    }
  }
}

/** Node Buffer → a tight ArrayBuffer slice (ExcelJS.load wants an ArrayBuffer). */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

/** XML-escape a formula body for an OOXML `<f>` element. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Repair ExcelJS's rare surrogate-at-chunk-boundary corruption.
 *
 * ExcelJS's XML writer flushes in ~80 KB chunks; when a UTF-16 surrogate pair
 * (an emoji such as "📅" in a prefixed sheet name) straddles a chunk boundary,
 * each lone surrogate serializes as the U+FFFD replacement character, silently
 * breaking one `<f>` formula. It is deterministic but content/offset-specific.
 *
 * This pass re-reads the freshly written zip, and for every worksheet XML that
 * contains U+FFFD, rewrites the affected cells' `<f>` bodies from `formulaLog`
 * (the exact formula text we asked ExcelJS to write). JSZip encodes the repaired
 * string as proper UTF-8, so the surrogate pair is restored intact. Cells not in
 * the log, or XML with no U+FFFD, are left byte-for-byte untouched.
 *
 * Returns the repaired buffer plus a count of cells fixed (for the caller's
 * verification/telemetry).
 */
async function repairSurrogateCorruption(
  buffer: Buffer,
  formulaLog: FormulaLog,
): Promise<{ buffer: Buffer; repaired: number }> {
  // Note: we can't byte-scan for U+FFFD here — the corruption is a *lone
  // surrogate* in the UTF-8 stream, not the 3-byte U+FFFD sequence, so it only
  // surfaces once JSZip decodes a part to a JS string (lone surrogate → "�").
  // Detection therefore happens per-part on the decoded string below.
  const zip = await JSZip.loadAsync(buffer);

  // Map each worksheet part (xl/worksheets/sheetN.xml) → its display name, via
  // workbook.xml (sheet name + r:id) joined to workbook.xml.rels (r:id → target).
  const wbXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  const partToName = new Map<string, string>();
  if (wbXml && relsXml) {
    const relTarget = new Map<string, string>();
    for (const m of relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g)) {
      relTarget.set(m[1], m[2]);
    }
    for (const m of wbXml.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"[^>]*\/?>/g)) {
      const name = decodeXmlEntities(m[1]);
      const target = relTarget.get(m[2]);
      if (!target) continue;
      const part = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
      partToName.set(part, name);
    }
  }

  let repaired = 0;
  for (const part of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(part)) continue;
    const xml = await zip.file(part)!.async("string");
    if (!xml.includes("�")) continue;

    const sheetName = partToName.get(part);
    const cellFormulas = sheetName ? formulaLog.get(sheetName) : undefined;
    if (!cellFormulas) continue;

    // Replace each corrupted cell's <f>…</f> body with the known-good formula.
    // Match a cell element <c r="ADDR" …>…<f …>BODY</f>… where BODY has U+FFFD.
    let partRepairs = 0;
    const fixed = xml.replace(
      /<c\b[^>]*\br="([A-Z]+\d+)"[^>]*>([\s\S]*?)<\/c>/g,
      (whole, addr: string, inner: string) => {
        if (!inner.includes("�")) return whole;
        const good = cellFormulas.get(addr);
        if (!good) return whole; // not a logged formula cell — leave as-is
        // Swap just the <f> body; drop any stale cached <v> so Excel recomputes.
        const fixedInner = inner
          .replace(/(<f\b[^>]*>)[\s\S]*?(<\/f>)/, `$1${xmlEscape(good)}$2`)
          .replace(/<v\b[^>]*>[\s\S]*?<\/v>/, "");
        partRepairs++;
        return whole.replace(inner, fixedInner);
      },
    );

    // Only rewrite the part if we actually fixed something — re-encoding an
    // unchanged part that still held a lone surrogate would bake in the
    // corruption permanently. Store the repaired XML as a pre-encoded UTF-8
    // Buffer, NOT a JS string: JSZip's string writer chunks the encode and would
    // re-split a surrogate pair at the new boundary (the same class of bug we're
    // fixing). A Buffer is written as raw bytes, so the emoji stays intact.
    if (partRepairs > 0) {
      repaired += partRepairs;
      zip.file(part, Buffer.from(fixed, "utf8"));
    }
  }

  if (repaired === 0) return { buffer, repaired: 0 };
  const out = (await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  })) as Buffer;
  return { buffer: out, repaired };
}

/** Minimal XML entity decode for sheet names read out of workbook.xml. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Build the full-fidelity combined workbook: EVERY tab of every selected
 * tracker, each carrying the template's formatting and live-data formulas, with
 * cross-sheet rollups rewired to the prefixed sheet names so they recompute on
 * open. Returns the .xlsx bytes.
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

  // Global set of sheet names already taken across the whole combined workbook.
  const taken = new Set<string>();
  // Records every formula written (sheet → address → text) so the post-write
  // pass can repair any surrogate-at-chunk-boundary corruption.
  const formulaLog: FormulaLog = new Map();

  for (const tracker of trackers) {
    const { buffer } = await buildPopulatedTemplate(
      tracker,
      orgId,
      projectId,
      projectKey,
    );

    const src = new ExcelJS.Workbook();
    await src.xlsx.load(toArrayBuffer(buffer));

    const code = TRACKER_CODE[tracker];

    // 1) Allocate the new (unique, ≤31-char) name for every sheet in this
    //    tracker, building the rename map BEFORE copying so formulas in any
    //    sheet can resolve refs to any other sheet of the same tracker.
    const renameMap = new Map<string, string>();
    const planned: { srcSheet: ExcelJS.Worksheet; newName: string }[] = [];
    for (const ws of src.worksheets) {
      const newName = makeSheetName(code, ws.name, taken);
      renameMap.set(ws.name, newName);
      planned.push({ srcSheet: ws, newName });
    }

    // 2) Create + copy each sheet under its new name.
    for (const { srcSheet, newName } of planned) {
      const dst = out.addWorksheet(newName, {
        views: srcSheet.views?.length ? srcSheet.views : undefined,
      });
      copyWorksheet(srcSheet, dst, renameMap, formulaLog);
    }
  }

  // Force Excel to fully recalculate (and drop any stale cached values) on open.
  out.calcProperties.fullCalcOnLoad = true;

  const arrayBuf = await out.xlsx.writeBuffer();
  const written = Buffer.from(arrayBuf as ArrayBuffer);

  // Repair any U+FFFD that ExcelJS introduced by splitting an emoji surrogate
  // pair across an XML write-chunk boundary. No-op when the file is clean.
  const { buffer } = await repairSurrogateCorruption(written, formulaLog);
  return buffer;
}
