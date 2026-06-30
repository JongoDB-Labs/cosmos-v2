"use client";

/**
 * Client-side spreadsheet/CSV parsing for the import wizard. Parsing happens in
 * the BROWSER so the mapping UI can show headers + sample rows before anything
 * is sent to the server; the API then receives normalized rows (header → cell)
 * plus the mapping, never the raw file. XLSX support is dynamically imported so
 * SheetJS stays out of the initial bundle.
 *
 * Two entry points:
 *   - `parseImportFile(file)` → the legacy single-shape `{ headers, rows }`. It
 *     reads sheet 0 and auto-detects the header row, so clean exports (Jira CSV
 *     with the header on line 1) behave exactly as before while messy workbooks
 *     get their title/description rows skipped automatically.
 *   - `parseWorkbook(file)` → every sheet as a raw string matrix, for the
 *     generic wizard which lets the user pick the sheet AND the header row.
 */

export interface ParsedFile {
  headers: string[];
  rows: Record<string, string>[];
}

/** A workbook as raw string matrices — one entry per sheet (CSV/TSV = one). */
export interface Workbook {
  sheets: { name: string; matrix: string[][] }[];
}

/** Coerce a raw cell to a string without altering its content (legacy shape). */
function cellToString(v: unknown): string {
  return (v ?? "").toString();
}

/**
 * Collapse internal whitespace to single spaces — applied to HEADER cells only.
 * Spreadsheet headers routinely embed hard line breaks ("Deliverable\r\nID") for
 * visual wrapping; flattening yields clean, matchable text ("Deliverable ID").
 * Data cells are left byte-for-byte intact so multi-line values survive.
 */
function flattenHeader(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

/** RFC-4180-ish delimited parser (handles quotes, escaped quotes, CRLF). */
function parseDelimited(text: string, delimiter: string): string[][] {
  // Strip a UTF-8 BOM that Excel/Jira often prepend.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // Trailing field/row (no final newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Build a header list from one matrix row, de-duplicating blank/dup names. */
function buildHeaders(rawRow: string[]): string[] {
  const seen = new Set<string>();
  return rawRow.map((h, i) => {
    const base = flattenHeader(h ?? "") || `Column ${i + 1}`;
    let name = base;
    let k = 1;
    // Loop until the FINAL name is unused, and register THAT name — so a
    // renamed dup (e.g. "Comment (2)") can't collide with a later literal one.
    while (seen.has(name)) {
      k++;
      name = `${base} (${k})`;
    }
    seen.add(name);
    return name;
  });
}

/**
 * Pick the most likely header row in a matrix: the row with the MOST non-empty
 * cells, tie-broken by the EARLIEST row. Rows that are effectively a single wide
 * cell (a title or one-line description above the real table) are ignored, so a
 * "DELIVERABLE REGISTER" banner on row 0 never beats the actual header below it.
 * Falls back to the first non-empty row (then 0) when nothing has 2+ cells.
 */
export function guessHeaderRow(matrix: string[][]): number {
  let bestIdx = -1;
  let bestCount = 0;
  for (let i = 0; i < matrix.length; i++) {
    const count = (matrix[i] ?? []).filter((c) => (c ?? "").trim() !== "").length;
    if (count < 2) continue; // skip blank / single-cell title rows
    if (count > bestCount) {
      bestCount = count;
      bestIdx = i;
    }
  }
  if (bestIdx !== -1) return bestIdx;
  // Degenerate sheet (≤1 populated cell per row): first non-empty row, else 0.
  const firstNonEmpty = matrix.findIndex((r) =>
    (r ?? []).some((c) => (c ?? "").trim() !== ""),
  );
  return firstNonEmpty === -1 ? 0 : firstNonEmpty;
}

/**
 * Turn a raw string matrix into `{ headers, rows }` using the row at
 * `headerRowIndex` as the header. Rows above it are ignored; fully-blank rows
 * after it are skipped. Reuses the blank/dup header de-duplication so callers
 * get the same header shape as the legacy path.
 */
export function matrixToObjects(
  matrix: string[][],
  headerRowIndex: number,
  /** First data row (0-based). Lets callers skip instruction/template rows that
   *  sit BELOW the header. Defaults to the row right after the header. */
  dataStartRow?: number,
): ParsedFile {
  const idx = Math.max(0, Math.min(headerRowIndex, matrix.length - 1));
  const headers = buildHeaders(matrix[idx] ?? []);
  const rows: Record<string, string>[] = [];
  const start = Math.max(idx + 1, dataStartRow ?? idx + 1);
  for (let r = start; r < matrix.length; r++) {
    const cells = matrix[r];
    if (!cells || cells.every((c) => (c ?? "").trim() === "")) continue; // skip blank lines
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (cells[i] ?? "").toString();
    });
    rows.push(obj);
  }
  return { headers, rows };
}

/**
 * Read a file into one raw string matrix per sheet. XLSX yields every sheet;
 * CSV/TSV yields a single sheet named after the file. Cells are normalized
 * strings (formatted values, internal whitespace collapsed).
 */
export async function parseWorkbook(file: File): Promise<Workbook> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    // Dynamic import — keep SheetJS out of the main bundle.
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheets = wb.SheetNames.map((sheetName) => {
      const sheet = wb.Sheets[sheetName];
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: false, // keep formatted strings (dates as text)
        defval: "",
        blankrows: false,
      });
      return {
        name: sheetName,
        matrix: matrix.map((row) => (row ?? []).map(cellToString)),
      };
    });
    return { sheets };
  }
  // CSV / TSV — sniff the delimiter from the first line by MAJORITY (a stray
  // tab inside a quoted CSV header must not flip the whole file to TSV). The
  // .tsv extension is an explicit override.
  const text = await file.text();
  const nl = text.indexOf("\n");
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const delimiter = name.endsWith(".tsv") || tabs > commas ? "\t" : ",";
  const matrix = parseDelimited(text, delimiter).map((row) => row.map(cellToString));
  // Sheet name = the file's base name (drop the extension).
  const base = file.name.replace(/\.[^./\\]+$/, "") || file.name;
  return { sheets: [{ name: base, matrix }] };
}

/**
 * Legacy single-shape parse: sheet 0, header row auto-detected. Preserves the
 * old behavior for clean files (a header on line 1 → `guessHeaderRow` returns 0)
 * and is a strict improvement otherwise (title/description rows auto-skipped).
 */
export async function parseImportFile(file: File): Promise<ParsedFile> {
  const wb = await parseWorkbook(file);
  const sheet = wb.sheets[0];
  if (!sheet) return { headers: [], rows: [] };
  return matrixToObjects(sheet.matrix, guessHeaderRow(sheet.matrix));
}
