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
 * merged ranges, and tab colors. ExcelJS does NOT round-trip chart parts, so the
 * merge itself is chartless — but {@link injectBurnCharts} can graft burn's 11
 * charts back in via raw OOXML surgery (opt-in through `buildCombinedWorkbook`'s
 * `withCharts`). That charted variant is only ever *served* after a headless
 * LibreOffice render-to-PDF validates it isn't corrupt; the export route gates
 * on that. Absent LibreOffice (or on a failed render) the caller ships the clean
 * chartless file, so an un-validated charted workbook never reaches a user.
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

// ── chart injection (raw OOXML surgery) ──────────────────────────────────────

/**
 * Map every `<sheet name="…" r:id="rN">` in a workbook.xml to its worksheet
 * part path (`xl/worksheets/sheetN.xml`), by joining workbook.xml to its rels.
 * Shared shape between the burn source and the merged target.
 */
function mapSheetNamesToParts(
  workbookXml: string,
  relsXml: string,
): Map<string, string> {
  const relTarget = new Map<string, string>();
  for (const m of relsXml.matchAll(
    /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g,
  )) {
    relTarget.set(m[1], m[2]);
  }
  const out = new Map<string, string>();
  for (const m of workbookXml.matchAll(
    /<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"[^>]*\/?>/g,
  )) {
    const target = relTarget.get(m[2]);
    if (!target) continue;
    const part = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    out.set(decodeXmlEntities(m[1]), part);
  }
  return out;
}

/**
 * Graft burn's charts into the merged (chartless) workbook via raw OOXML edits.
 *
 * ExcelJS drops chart parts on load, so the merge has none. This reaches back
 * into burn's own populated template ({@link buildPopulatedTemplate}) — which
 * still carries its 11 charts on 2 drawings — and copies those parts into the
 * merged zip under collision-free names, rewires every reference, and attaches
 * the drawings to the merged "BRN · …" chart worksheets. Concretely:
 *
 *   1. Copy `xl/charts/chart*.xml` and `xl/drawings/drawing*.xml` (+ the
 *      drawings' `_rels`) into the merged zip, renaming each part to a name that
 *      doesn't collide with anything already there.
 *   2. Rewrite each chart's `<c:f>` sheet refs from the original burn sheet name
 *      (e.g. `'📈 CLIN Charts'`) to its merged name (`'BRN · 📈 CLIN Charts'`).
 *      Names are read from BOTH workbooks' workbook.xml (never hard-coded) and
 *      replaced as LITERAL substrings — not regex — because the names contain
 *      emoji (UTF-16 surrogate pairs) a global RegExp could split.
 *   3. Rewrite each drawing `_rels` chart target to the renamed chart part.
 *   4. For each burn worksheet that hosted a drawing, find the matching merged
 *      "BRN · …" worksheet, add a worksheet `_rels` pointing at the renamed
 *      drawing, and insert `<drawing r:id="…"/>` just before `</worksheet>`.
 *   5. Register every new chart/drawing part as an Override in
 *      `[Content_Types].xml`.
 *
 * Returns the new .xlsx bytes. If burn carries no charts (defensive), returns
 * the input unchanged.
 */
export async function injectBurnCharts(
  mergedBuffer: Buffer,
  orgId: string,
  projectId: string,
  projectKey: string,
): Promise<Buffer> {
  // Burn's own populated template still has its charts/drawings intact.
  const { buffer: burnBuffer } = await buildPopulatedTemplate(
    "burn",
    orgId,
    projectId,
    projectKey,
  );
  const burnZip = await JSZip.loadAsync(burnBuffer);
  const mergedZip = await JSZip.loadAsync(mergedBuffer);

  const chartParts = Object.keys(burnZip.files)
    .filter((p) => /^xl\/charts\/chart\d+\.xml$/.test(p))
    .sort();
  const drawingParts = Object.keys(burnZip.files)
    .filter((p) => /^xl\/drawings\/drawing\d+\.xml$/.test(p))
    .sort();

  // Nothing to inject (shouldn't happen for a real burn template, but be safe).
  if (chartParts.length === 0 || drawingParts.length === 0) return mergedBuffer;

  // ── name maps: burn sheet name → merged sheet name ─────────────────────────
  const burnWb = await burnZip.file("xl/workbook.xml")!.async("string");
  const burnWbRels = await burnZip
    .file("xl/_rels/workbook.xml.rels")!
    .async("string");
  const mergedWb = await mergedZip.file("xl/workbook.xml")!.async("string");
  const mergedWbRels = await mergedZip
    .file("xl/_rels/workbook.xml.rels")!
    .async("string");

  const burnSheetToPart = mapSheetNamesToParts(burnWb, burnWbRels);
  const mergedSheetToPart = mapSheetNamesToParts(mergedWb, mergedWbRels);

  // Burn's sheets land in the merge under "BRN · <orig>" (possibly truncated /
  // de-duped by makeSheetName). Read the ACTUAL merged names rather than
  // recomputing them: match every merged sheet that ends with a burn sheet's
  // (cleaned) original name behind the "BRN · " prefix. To be robust we map by
  // looking for a merged name whose tail equals the burn name after stripping
  // the prefix; the simplest reliable join is: for each burn sheet name, find
  // the merged name that is `"BRN · " + <that burn name>` (post-clean), else the
  // unique merged name containing it.
  const mergedNames = [...mergedSheetToPart.keys()];
  const burnToMergedName = new Map<string, string>();
  for (const burnName of burnSheetToPart.keys()) {
    const exact = `BRN${SEP}${burnName.replace(FORBIDDEN_SHEET_CHARS, " ").replace(/\s+/g, " ").trim()}`;
    let match = mergedNames.find((n) => n === exact);
    if (!match) {
      // Truncation/dedupe fallback: the merged name starts with "BRN · " and the
      // burn name's leading slice. Pick the unique BRN sheet that startsWith the
      // truncated form. (For the real burn template the exact match always hits.)
      const prefixForm = exact.slice(0, MAX_SHEET_NAME);
      match = mergedNames.find(
        (n) => n.startsWith("BRN" + SEP) && n.startsWith(prefixForm),
      );
    }
    if (match) burnToMergedName.set(burnName, match);
  }

  // ── unique target part names in the merged zip ─────────────────────────────
  const existing = new Set(Object.keys(mergedZip.files));
  const uniquePart = (preferred: string): string => {
    if (!existing.has(preferred)) {
      existing.add(preferred);
      return preferred;
    }
    const dot = preferred.lastIndexOf(".");
    const stem = dot === -1 ? preferred : preferred.slice(0, dot);
    const ext = dot === -1 ? "" : preferred.slice(dot);
    for (let n = 1; n < 10000; n++) {
      const cand = `${stem}_m${n}${ext}`;
      if (!existing.has(cand)) {
        existing.add(cand);
        return cand;
      }
    }
    throw new Error(`could not allocate unique part name for ${preferred}`);
  };

  // burn part path → merged part path (charts + drawings)
  const partRename = new Map<string, string>();
  for (const cp of chartParts) {
    const base = cp.slice(cp.lastIndexOf("/") + 1); // chartN.xml
    partRename.set(cp, uniquePart(`xl/charts/${base}`));
  }
  for (const dp of drawingParts) {
    const base = dp.slice(dp.lastIndexOf("/") + 1); // drawingN.xml
    partRename.set(dp, uniquePart(`xl/drawings/${base}`));
  }

  // ── copy + rewrite chart parts (c:f sheet-ref rewrite) ─────────────────────
  for (const cp of chartParts) {
    let xml = await burnZip.file(cp)!.async("string");
    // Rewrite quoted sheet refs '<burn>'! → '<merged>'! and unquoted forms.
    // Burn chart names are always quoted (they contain spaces + emoji), but
    // handle both. LITERAL replace (surrogate-safe), longest name first.
    const burnNames = [...burnToMergedName.keys()].sort(
      (a, b) => b.length - a.length,
    );
    for (const burnName of burnNames) {
      const mergedName = burnToMergedName.get(burnName)!;
      const quotedOld = `'${burnName.replace(/'/g, "''")}'`;
      const quotedNew = `'${mergedName.replace(/'/g, "''")}'`;
      if (xml.includes(quotedOld)) xml = xml.split(quotedOld).join(quotedNew);
    }
    mergedZip.file(partRename.get(cp)!, Buffer.from(xml, "utf8"));
  }

  // ── copy + rewrite drawing parts and their _rels ───────────────────────────
  for (const dp of drawingParts) {
    // Drawing body copied verbatim (its r:ids stay; only the rels TARGETS move).
    const body = await burnZip.file(dp)!.async("nodebuffer");
    mergedZip.file(partRename.get(dp)!, body);

    // Rewrite the drawing's _rels chart targets to the renamed chart parts.
    const relsPart = dp.replace(
      /drawings\/(drawing\d+\.xml)$/,
      "drawings/_rels/$1.rels",
    );
    const relsFile = burnZip.file(relsPart);
    if (!relsFile) continue;
    let relsXml = await relsFile.async("string");
    relsXml = relsXml.replace(
      /Target="([^"]+)"/g,
      (whole, target: string) => {
        // Resolve "../charts/chartN.xml" (relative to xl/drawings/) → xl/charts/…
        const norm = target.startsWith("../")
          ? `xl/${target.slice(3)}`
          : target.startsWith("/")
            ? target.slice(1)
            : `xl/drawings/${target}`;
        const renamed = partRename.get(norm);
        if (!renamed) return whole; // not a chart we moved — leave it
        // New target is relative to xl/drawings/ again.
        const rel = `../${renamed.replace(/^xl\//, "")}`;
        return `Target="${rel}"`;
      },
    );
    const mergedDrawing = partRename.get(dp)!;
    const mergedRelsPart = mergedDrawing.replace(
      /drawings\/(drawing[^/]+\.xml)$/,
      "drawings/_rels/$1.rels",
    );
    mergedZip.file(mergedRelsPart, Buffer.from(relsXml, "utf8"));
  }

  // ── attach drawings to the merged BRN worksheets ───────────────────────────
  // For each burn worksheet that hosted a drawing, find which drawing, map the
  // burn sheet → merged "BRN · …" sheet, and wire the merged worksheet to the
  // (renamed) drawing via a fresh _rels + a <drawing r:id> element.
  for (const burnWsPart of Object.keys(burnZip.files).filter((p) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(p),
  )) {
    const burnWsXml = await burnZip.file(burnWsPart)!.async("string");
    const drawTag = burnWsXml.match(/<drawing\b[^>]*r:id="([^"]+)"/);
    if (!drawTag) continue;
    const burnWsRelsPart = burnWsPart.replace(
      /worksheets\/(sheet\d+\.xml)$/,
      "worksheets/_rels/$1.rels",
    );
    const burnWsRels = await burnZip.file(burnWsRelsPart)?.async("string");
    if (!burnWsRels) continue;
    // The r:id in the <drawing> → its drawing target in the worksheet rels.
    const relRe = new RegExp(
      `<Relationship\\b[^>]*Id="${drawTag[1]}"[^>]*Target="([^"]+)"`,
    );
    const tgt = burnWsRels.match(relRe);
    if (!tgt) continue;
    const burnDrawingPart = tgt[1].startsWith("../")
      ? `xl/${tgt[1].slice(3)}`
      : `xl/worksheets/${tgt[1]}`;
    const mergedDrawingPart = partRename.get(burnDrawingPart);
    if (!mergedDrawingPart) continue;

    // burn sheet display name → merged display name → merged worksheet part.
    const burnSheetName = [...burnSheetToPart.entries()].find(
      ([, part]) => part === burnWsPart,
    )?.[0];
    if (!burnSheetName) continue;
    const mergedName = burnToMergedName.get(burnSheetName);
    if (!mergedName) continue;
    const mergedWsPart = mergedSheetToPart.get(mergedName);
    if (!mergedWsPart) continue;

    // Worksheet _rels: append (or create) a drawing relationship with a fresh,
    // non-colliding rId. Target is relative to xl/worksheets/.
    const mergedWsRelsPart = mergedWsPart.replace(
      /worksheets\/(sheet\d+\.xml)$/,
      "worksheets/_rels/$1.rels",
    );
    const relTarget = `../${mergedDrawingPart.replace(/^xl\//, "")}`;
    const DRAWING_REL_TYPE =
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";

    let rId: string;
    const existingRels = await mergedZip.file(mergedWsRelsPart)?.async("string");
    if (existingRels) {
      // Pick an rId not already used in this rels file.
      const used = new Set(
        [...existingRels.matchAll(/Id="(rId\d+)"/g)].map((m) => m[1]),
      );
      let n = 1;
      while (used.has(`rId${n}`)) n++;
      rId = `rId${n}`;
      const relEl = `<Relationship Id="${rId}" Type="${DRAWING_REL_TYPE}" Target="${relTarget}"/>`;
      const merged = existingRels.replace("</Relationships>", `${relEl}</Relationships>`);
      mergedZip.file(mergedWsRelsPart, Buffer.from(merged, "utf8"));
    } else {
      rId = "rId1";
      const relsDoc =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="${rId}" Type="${DRAWING_REL_TYPE}" Target="${relTarget}"/>` +
        `</Relationships>`;
      mergedZip.file(mergedWsRelsPart, Buffer.from(relsDoc, "utf8"));
    }

    // Insert <drawing r:id="…"/> just before </worksheet>. Skip if one is
    // already present (defensive — the chartless merge never has one).
    let wsXml = await mergedZip.file(mergedWsPart)!.async("string");
    if (!/<drawing\b/.test(wsXml)) {
      wsXml = wsXml.replace(
        /<\/worksheet>\s*$/,
        `<drawing r:id="${rId}"/></worksheet>`,
      );
      mergedZip.file(mergedWsPart, Buffer.from(wsXml, "utf8"));
    }
  }

  // ── register new parts in [Content_Types].xml ──────────────────────────────
  const CHART_CT =
    "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
  const DRAWING_CT =
    "application/vnd.openxmlformats-officedocument.drawing+xml";
  let ct = await mergedZip.file("[Content_Types].xml")!.async("string");
  const overrides: string[] = [];
  for (const cp of chartParts) {
    overrides.push(
      `<Override PartName="/${partRename.get(cp)!}" ContentType="${CHART_CT}"/>`,
    );
  }
  for (const dp of drawingParts) {
    overrides.push(
      `<Override PartName="/${partRename.get(dp)!}" ContentType="${DRAWING_CT}"/>`,
    );
  }
  ct = ct.replace("</Types>", `${overrides.join("")}</Types>`);
  mergedZip.file("[Content_Types].xml", Buffer.from(ct, "utf8"));

  return (await mergedZip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  })) as Buffer;
}

/**
 * Build the full-fidelity combined workbook: EVERY tab of every selected
 * tracker, each carrying the template's formatting and live-data formulas, with
 * cross-sheet rollups rewired to the prefixed sheet names so they recompute on
 * open. Returns the .xlsx bytes.
 *
 * With `opts.withCharts` AND "burn" among the trackers, burn's 11 charts are
 * grafted back onto the merged "BRN · …" sheets via {@link injectBurnCharts}.
 * The charted bytes are only safe to serve once a headless-LibreOffice render
 * validates them — that gating lives in the export route, not here.
 */
export async function buildCombinedWorkbook(
  orgId: string,
  projectId: string,
  projectKey: string,
  trackers: Tracker[],
  opts?: { withCharts?: boolean },
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

  // Optionally graft burn's charts back onto the merged BRN sheets. Only when
  // burn is actually part of this export — otherwise there are no chart sheets
  // to attach to. The caller validates the charted bytes (render-to-PDF) before
  // serving them.
  if (opts?.withCharts && trackers.includes("burn")) {
    return injectBurnCharts(buffer, orgId, projectId, projectKey);
  }
  return buffer;
}
