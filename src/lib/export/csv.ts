/** A cell a spreadsheet would run as a formula: = + - @, TAB or CR first. */
const FORMULA_START = /^[=+\-@\t\r]/;
/** …unless it is only a number, which a spreadsheet reads as a value. */
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Neutralize CSV formula injection (OWASP "CSV Injection"): text that starts
 * with a formula trigger is prefixed with a single quote, so Excel, LibreOffice
 * and Sheets show it as text instead of executing it. Only TEXT is guarded. A
 * JS number (e.g. -3 hours) never reaches this, and a string that is just a
 * number ("-3", "+1.5") is left alone, so real figures stay numeric.
 */
export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
}

// Minimal RFC-4180 CSV serializer. Every export goes through here, so the
// formula guard lives here once rather than at each call site.
export function toCSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    let s: string;
    if (val instanceof Date) s = val.toISOString();
    else if (typeof val === "bigint") s = val.toString();
    else if (typeof val === "object") s = JSON.stringify(val);
    else if (typeof val === "string") s = neutralizeFormula(val);
    else s = String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
}

/**
 * Parse RFC-4180 CSV. No import reads our own exports back through this, so the
 * quote `toCSV` adds to formula-like cells is never stripped here: a cell that
 * really starts with a quote must survive as typed.
 */
export function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        if (field !== "" || row.length > 0) { row.push(field); rows.push(row); row = []; field = ""; }
      } else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  const headers = rows.shift() ?? [];
  return {
    headers,
    rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))),
  };
}
