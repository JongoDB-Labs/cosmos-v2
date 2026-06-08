"use client";

/**
 * Client-side spreadsheet/CSV parsing for the import wizard. Parsing happens in
 * the BROWSER so the mapping UI can show headers + sample rows before anything
 * is sent to the server; the API then receives normalized rows (header → cell)
 * plus the mapping, never the raw file. XLSX support is dynamically imported so
 * SheetJS stays out of the initial bundle.
 */

export interface ParsedFile {
  headers: string[];
  rows: Record<string, string>[];
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

/** Turn a header row + data rows into objects, de-duplicating blank/dup headers. */
function toObjects(matrix: string[][]): ParsedFile {
  const raw = matrix.find((r) => r.some((c) => c.trim() !== "")) ?? [];
  const headerIdx = matrix.indexOf(raw);
  const seen = new Set<string>();
  const headers = raw.map((h, i) => {
    const base = (h ?? "").trim() || `Column ${i + 1}`;
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
  const rows: Record<string, string>[] = [];
  for (let r = headerIdx + 1; r < matrix.length; r++) {
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

export async function parseImportFile(file: File): Promise<ParsedFile> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    // Dynamic import — keep SheetJS out of the main bundle.
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      raw: false, // keep formatted strings (dates as text)
      defval: "",
      blankrows: false,
    });
    return toObjects(matrix.map((r) => r.map((c) => (c ?? "").toString())));
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
  return toObjects(parseDelimited(text, delimiter));
}
