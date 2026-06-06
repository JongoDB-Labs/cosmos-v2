// scripts/check-control-coverage.mjs
// CI gate: validates the living SSP control-coverage matrix.
//
// Fails if:
//   1. The CSV has fewer than 110 rows.
//   2. Any row is missing controlId, family, practice, implementedBy, or status.
//   3. A non-policy row with status="implemented" points at an evidencePath that
//      doesn't exist on disk.
//
// For planned / partial / policy-* / inherited rows, an empty or "-" evidencePath
// is explicitly allowed.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CSV_PATH = path.join(REPO_ROOT, "compliance", "ssp", "control-coverage.csv");

const REQUIRED_COLS = ["controlId", "family", "practice", "implementedBy", "status"];
const MIN_ROWS = 110;

// implementedBy values that are "policy-type" — evidencePath is allowed to be absent/"-"
// for any status value on these rows.
const POLICY_IMPL = new Set(["policy", "inherited"]);

// Status values for which a missing/"-" evidencePath is always allowed (regardless of implementedBy).
const EXEMPT_STATUSES = new Set([
  "planned",
  "partial",
  "policy-required-not-yet-authored",
  "inherited",
]);

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { headers: [], rows: [] };

  // Simple CSV parser that handles semicolons in quoted fields.
  function parseRow(line) {
    const cells = [];
    let current = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { current += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === "," && !inQuote) {
        cells.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells.map((c) => c.trim());
  }

  const headers = parseRow(lines[0]);
  const rows = lines.slice(1).map((line, idx) => {
    const cells = parseRow(line);
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = cells[i] ?? "";
    }
    obj._lineNum = idx + 2; // 1-indexed, +1 for header
    return obj;
  });

  return { headers, rows };
}

// ── Main ──────────────────────────────────────────────────────────────────────

let csv;
try {
  csv = readFileSync(CSV_PATH, "utf8");
} catch (e) {
  console.error(`ERROR: Cannot read ${CSV_PATH}: ${e.message}`);
  process.exit(1);
}

const { headers, rows } = parseCsv(csv);

// 1. Check header has all required columns.
const missingCols = REQUIRED_COLS.filter((c) => !headers.includes(c));
if (missingCols.length > 0) {
  console.error(`ERROR: CSV is missing required columns: ${missingCols.join(", ")}`);
  process.exit(1);
}

// 2. Check row count.
if (rows.length < MIN_ROWS) {
  console.error(
    `ERROR: Expected at least ${MIN_ROWS} practice rows; found ${rows.length}.`,
  );
  process.exit(1);
}

// 3. Validate each row.
const errors = [];

for (const row of rows) {
  const { controlId, family, practice, implementedBy, status, evidencePath } = row;
  const loc = `row ${row._lineNum} (${controlId || "?"})`;

  // Required fields must be non-empty.
  for (const col of REQUIRED_COLS) {
    if (!row[col] || row[col].trim() === "") {
      errors.push(`${loc}: missing required field '${col}'`);
    }
  }

  // For non-policy rows with status=implemented, evidencePath must exist on disk.
  if (
    !POLICY_IMPL.has(implementedBy) &&
    status === "implemented" &&
    !EXEMPT_STATUSES.has(status)
  ) {
    const ep = (evidencePath ?? "").trim();
    if (!ep || ep === "-") {
      errors.push(
        `${loc}: implementedBy=${implementedBy} status=implemented but evidencePath is empty or "-"`,
      );
    } else {
      const full = path.join(REPO_ROOT, ep);
      if (!existsSync(full)) {
        errors.push(`${loc}: evidencePath does not exist on disk: ${ep}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`\nControl-coverage gate FAILED — ${errors.length} issue(s):\n`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}

// ── Summary ───────────────────────────────────────────────────────────────────

// Count by implementedBy
const byImpl = {};
for (const r of rows) {
  byImpl[r.implementedBy] = (byImpl[r.implementedBy] ?? 0) + 1;
}

// Count by status
const byStatus = {};
for (const r of rows) {
  byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
}

console.log(`\nControl-coverage gate PASSED — ${rows.length} practices mapped.\n`);
console.log("  implementedBy breakdown:");
for (const [k, v] of Object.entries(byImpl).sort()) {
  console.log(`    ${k.padEnd(16)} ${v}`);
}
console.log("\n  status breakdown:");
for (const [k, v] of Object.entries(byStatus).sort()) {
  console.log(`    ${k.padEnd(36)} ${v}`);
}
console.log("");
console.log(
  "  NOTE: ~38 administrative/physical/personnel practices are marked",
);
console.log(
  "  'policy-required-not-yet-authored' — honest, not green-by-omission.",
);
console.log(
  "  A C3PAO assessment requires those written policies in addition to",
);
console.log("  the technical controls evidenced here.\n");
