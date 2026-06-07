// scripts/cutover/lib/parity-lib.ts
//
// Pure helpers for the §9.2 cutover schema-parity + provenance HARD gate
// (scripts/cutover/parity-gate.mjs). Kept side-effect-free so they can be unit-tested
// without a database, a clock, or the filesystem:
//
//   * computeMigrationHistoryHash() — a STABLE sha256 over prod's _prisma_migrations
//     history (ordered migration_name + checksum). This is the provenance fingerprint
//     written into compliance/provenance/prod-baseline.json so the cutover source-of-truth
//     is auditable: a different prod migration set ⇒ a different hash.
//
//   * parseMigrationRows() — tolerant parser for the two shapes a prod _prisma_migrations
//     export realistically arrives in: a JSON array of rows, or psql `--csv` output.
//
//   * classificationFkProbeSql() — the read-only SQL that asserts a FK
//     data_classifications.project_id -> projects.id exists in a restored prod snapshot
//     (gate part 2). Built as a function so the exact predicate is unit-testable.
//
//   * buildBaselineRecord() — assembles the provenance JSON object (no I/O; the caller
//     writes it). Timestamp is passed IN (Date.now()/new Date() may be restricted).

import { createHash } from "node:crypto";

// ── Migration-history fingerprint ────────────────────────────────────────────────────

export interface MigrationRow {
  /** _prisma_migrations.migration_name (e.g. "20260525000000_baseline"). */
  migration_name: string;
  /** _prisma_migrations.checksum (sha256 hex of the migration.sql at apply time). */
  checksum: string;
}

/**
 * STABLE sha256 over the ordered (migration_name, checksum) pairs of prod's applied
 * migration history. Determinism rules:
 *   - rows are SORTED by migration_name (the 14-digit timestamp prefix makes lexical sort
 *     == apply order), so the hash does NOT depend on the export's row order;
 *   - each pair is length-prefixed-framed ("<len>:<value>") so no concatenation collision
 *     is possible (e.g. names containing the field separator can't forge another row);
 *   - migration_name + checksum are the only inputs — applied_at / finished_at / logs are
 *     deliberately EXCLUDED (they differ per environment and would make the hash unstable).
 *
 * Returns a 64-char lowercase hex digest. Empty input ⇒ the sha256 of the empty string's
 * framed form (count=0), which is itself stable.
 */
export function computeMigrationHistoryHash(rows: MigrationRow[]): string {
  const sorted = [...rows].sort((a, b) =>
    a.migration_name < b.migration_name ? -1 : a.migration_name > b.migration_name ? 1 : 0,
  );
  const h = createHash("sha256");
  // Frame the count first so [] and [{name:"",checksum:""}] can never collide.
  h.update(frame(String(sorted.length)));
  for (const r of sorted) {
    h.update(frame(r.migration_name));
    h.update(frame(r.checksum));
  }
  return h.digest("hex");
}

/** Length-prefixed framing: "<byteLength>:<value>". Collision-proof concatenation. */
function frame(s: string): string {
  return `${Buffer.byteLength(s, "utf8")}:${s}`;
}

/**
 * Parse a prod _prisma_migrations export into MigrationRow[]. Accepts:
 *   - a JSON array of objects with at least { migration_name, checksum } (any extra
 *     fields ignored);
 *   - psql CSV (a header row naming migration_name + checksum, then data rows).
 * Throws on anything else (fail-closed: an unparseable provenance input is an error, not
 * a silently-empty history).
 */
export function parseMigrationRows(text: string): MigrationRow[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  // JSON array shape.
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) throw new Error("parseMigrationRows: JSON is not an array");
    return arr.map((row, i) => {
      const name = row?.migration_name;
      const checksum = row?.checksum;
      if (typeof name !== "string" || typeof checksum !== "string") {
        throw new Error(
          `parseMigrationRows: row ${i} missing migration_name/checksum (got ${JSON.stringify(row)})`,
        );
      }
      return { migration_name: name, checksum };
    });
  }

  // CSV shape (psql --csv). Header must name the two columns we need.
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 1) return [];
  const header = splitCsvLine(lines[0]);
  const nameIdx = header.indexOf("migration_name");
  const checkIdx = header.indexOf("checksum");
  if (nameIdx === -1 || checkIdx === -1) {
    throw new Error(
      "parseMigrationRows: CSV header must contain migration_name and checksum columns",
    );
  }
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const name = cells[nameIdx];
    const checksum = cells[checkIdx];
    if (name === undefined || checksum === undefined) {
      throw new Error(`parseMigrationRows: malformed CSV row: ${line}`);
    }
    return { migration_name: name, checksum };
  });
}

/** Minimal CSV line splitter (handles double-quoted fields with embedded commas/quotes). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

// ── Classification-FK probe (gate part 2) ────────────────────────────────────────────

export interface FkProbeSpec {
  /** Child table that must carry the FK. */
  table: string;
  /** Child column that must be the FK referencing column. */
  column: string;
  /** Referenced (parent) table. */
  refTable: string;
  /** Referenced (parent) column. */
  refColumn: string;
}

/** The §9.2 marker FK: data_classifications.project_id -> projects.id. */
export const CLASSIFICATION_FK: FkProbeSpec = {
  table: "data_classifications",
  column: "project_id",
  refTable: "projects",
  refColumn: "id",
};

/**
 * Build the read-only SQL that asserts the given FK exists in the connected database,
 * scoped to schema `public`. Walks pg_constraint (contype 'f') joining pg_attribute on
 * BOTH the child column (conkey) and the referenced column (confkey) so a FK that merely
 * touches the child table but references a DIFFERENT column does NOT count as a match.
 *
 * Returns SQL producing exactly one row, one boolean column `fk_exists`. The query is
 * fully parameterless and literal-injected from the FkProbeSpec — callers MUST only pass
 * trusted, code-defined specs (CLASSIFICATION_FK), never user input. Identifiers are
 * single-quoted string literals compared against catalog name columns (text), so this is
 * comparison, not identifier interpolation.
 */
export function classificationFkProbeSql(spec: FkProbeSpec = CLASSIFICATION_FK): string {
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return `
SELECT EXISTS (
  SELECT 1
  FROM pg_constraint con
  JOIN pg_class      child    ON child.oid    = con.conrelid
  JOIN pg_namespace  child_ns ON child_ns.oid = child.relnamespace
  JOIN pg_class      parent   ON parent.oid   = con.confrelid
  JOIN pg_namespace  parent_ns ON parent_ns.oid = parent.relnamespace
  JOIN pg_attribute  child_col  ON child_col.attrelid = con.conrelid
                                AND child_col.attnum  = con.conkey[1]
  JOIN pg_attribute  parent_col ON parent_col.attrelid = con.confrelid
                                AND parent_col.attnum  = con.confkey[1]
  WHERE con.contype = 'f'
    AND child_ns.nspname  = 'public'
    AND parent_ns.nspname = 'public'
    AND child.relname     = ${lit(spec.table)}
    AND child_col.attname = ${lit(spec.column)}
    AND parent.relname    = ${lit(spec.refTable)}
    AND parent_col.attname = ${lit(spec.refColumn)}
    AND array_length(con.conkey, 1) = 1
) AS fk_exists;`.trim();
}

// ── Provenance record assembly ───────────────────────────────────────────────────────

export interface BaselineRecord {
  prodCommit: string | null;
  migrationHistoryHash: string | null;
  migrationCount: number | null;
  parityGate: "pass" | "fail";
  classificationFk: boolean;
  checkedAt: string;
}

export interface BaselineInput {
  prodCommit?: string | null;
  migrationRows?: MigrationRow[] | null;
  parityGate: "pass" | "fail";
  classificationFk: boolean;
  /** ISO-8601 timestamp passed in by the caller (Date.now() may be restricted). */
  checkedAt: string;
}

/**
 * Assemble the provenance baseline record (no I/O). When migrationRows is provided the
 * history hash + count are computed; when absent they are null (the gate can still run
 * the two structural checks without a migrations export, but provenance is then partial).
 */
export function buildBaselineRecord(input: BaselineInput): BaselineRecord {
  const rows = input.migrationRows ?? null;
  return {
    prodCommit: input.prodCommit ?? null,
    migrationHistoryHash: rows ? computeMigrationHistoryHash(rows) : null,
    migrationCount: rows ? rows.length : null,
    parityGate: input.parityGate,
    classificationFk: input.classificationFk,
    checkedAt: input.checkedAt,
  };
}
