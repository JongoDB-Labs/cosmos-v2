// scripts/cutover/lib/parity-lib.test.ts
import { describe, it, expect } from "vitest";
import {
  computeMigrationHistoryHash,
  parseMigrationRows,
  classificationFkProbeSql,
  buildBaselineRecord,
  CLASSIFICATION_FK,
} from "./parity-lib";

describe("computeMigrationHistoryHash — determinism + sensitivity", () => {
  const rows = [
    { migration_name: "20260525000000_baseline", checksum: "aaa" },
    { migration_name: "20260606130000_audit_retention_checkpoint", checksum: "zzz" },
    { migration_name: "20260606040000_add_pgvector", checksum: "mmm" },
  ];

  it("is a 64-char lowercase hex digest", () => {
    const h = computeMigrationHistoryHash(rows);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is STABLE regardless of input row order (sorted by migration_name)", () => {
    const shuffled = [rows[2], rows[0], rows[1]];
    expect(computeMigrationHistoryHash(shuffled)).toBe(computeMigrationHistoryHash(rows));
  });

  it("changes when a checksum changes (catches a re-applied/edited migration)", () => {
    const tampered = rows.map((r) =>
      r.migration_name === "20260525000000_baseline" ? { ...r, checksum: "BBB" } : r,
    );
    expect(computeMigrationHistoryHash(tampered)).not.toBe(computeMigrationHistoryHash(rows));
  });

  it("changes when a migration is added or removed (count is framed in)", () => {
    const extra = [...rows, { migration_name: "20260607000000_new", checksum: "qqq" }];
    expect(computeMigrationHistoryHash(extra)).not.toBe(computeMigrationHistoryHash(rows));
    const fewer = rows.slice(0, 2);
    expect(computeMigrationHistoryHash(fewer)).not.toBe(computeMigrationHistoryHash(rows));
  });

  it("is collision-proof against field-separator forgery (length-prefix framing)", () => {
    // Two rows whose name/checksum could naively concatenate into the same byte stream.
    const a = [{ migration_name: "ab", checksum: "c" }];
    const b = [{ migration_name: "a", checksum: "bc" }];
    expect(computeMigrationHistoryHash(a)).not.toBe(computeMigrationHistoryHash(b));
  });

  it("empty history hashes stably (count=0 framed)", () => {
    expect(computeMigrationHistoryHash([])).toBe(computeMigrationHistoryHash([]));
    expect(computeMigrationHistoryHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseMigrationRows — JSON + CSV shapes", () => {
  it("parses a JSON array, ignoring extra fields", () => {
    const json = JSON.stringify([
      { id: "x", migration_name: "20260525000000_baseline", checksum: "aaa", applied_at: "t" },
      { migration_name: "20260606040000_add_pgvector", checksum: "mmm" },
    ]);
    expect(parseMigrationRows(json)).toEqual([
      { migration_name: "20260525000000_baseline", checksum: "aaa" },
      { migration_name: "20260606040000_add_pgvector", checksum: "mmm" },
    ]);
  });

  it("parses psql CSV by header position (column order independent)", () => {
    const csv = "checksum,migration_name,applied_at\naaa,20260525000000_baseline,t1\nmmm,20260606040000_add_pgvector,t2";
    expect(parseMigrationRows(csv)).toEqual([
      { migration_name: "20260525000000_baseline", checksum: "aaa" },
      { migration_name: "20260606040000_add_pgvector", checksum: "mmm" },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseMigrationRows("")).toEqual([]);
    expect(parseMigrationRows("   \n ")).toEqual([]);
  });

  it("throws (fail-closed) on JSON missing required fields", () => {
    expect(() => parseMigrationRows(JSON.stringify([{ migration_name: "x" }]))).toThrow();
  });

  it("throws (fail-closed) on CSV without the required columns", () => {
    expect(() => parseMigrationRows("foo,bar\n1,2")).toThrow();
  });

  it("round-trips with computeMigrationHistoryHash deterministically", () => {
    const csv = "migration_name,checksum\n20260525000000_baseline,aaa\n20260606040000_add_pgvector,mmm";
    const json = JSON.stringify(parseMigrationRows(csv));
    expect(computeMigrationHistoryHash(parseMigrationRows(csv))).toBe(
      computeMigrationHistoryHash(JSON.parse(json)),
    );
  });
});

describe("classificationFkProbeSql — the FK-probe SQL builder", () => {
  const sql = classificationFkProbeSql(CLASSIFICATION_FK);

  it("targets the exact §9.2 marker FK (child + column + parent + refcol)", () => {
    expect(sql).toContain("con.contype = 'f'");
    expect(sql).toContain("child.relname     = 'data_classifications'");
    expect(sql).toContain("child_col.attname = 'project_id'");
    expect(sql).toContain("parent.relname    = 'projects'");
    expect(sql).toContain("parent_col.attname = 'id'");
  });

  it("scopes both ends to the public schema", () => {
    expect(sql).toContain("child_ns.nspname  = 'public'");
    expect(sql).toContain("parent_ns.nspname = 'public'");
  });

  it("checks BOTH the referencing and referenced columns (conkey + confkey)", () => {
    expect(sql).toContain("con.conkey[1]");
    expect(sql).toContain("con.confkey[1]");
    // single-column FK only — a composite FK that merely includes project_id must not match.
    expect(sql).toContain("array_length(con.conkey, 1) = 1");
  });

  it("produces a single boolean column named fk_exists", () => {
    expect(sql).toContain("AS fk_exists");
    expect(sql.trim().startsWith("SELECT EXISTS")).toBe(true);
  });

  it("escapes single quotes in identifiers (no literal-injection)", () => {
    const evil = classificationFkProbeSql({
      table: "a'b",
      column: "c",
      refTable: "d",
      refColumn: "e",
    });
    expect(evil).toContain("'a''b'");
  });
});

describe("buildBaselineRecord — provenance assembly (no I/O)", () => {
  const rows = [
    { migration_name: "20260525000000_baseline", checksum: "aaa" },
    { migration_name: "20260606040000_add_pgvector", checksum: "mmm" },
  ];

  it("computes hash + count when migrations are provided; verdict pass when both gates pass", () => {
    const rec = buildBaselineRecord({
      prodCommit: "deadbeef",
      migrationRows: rows,
      parityGate: "pass",
      classificationFk: true,
      checkedAt: "2026-06-07T00:00:00Z",
    });
    expect(rec).toEqual({
      prodCommit: "deadbeef",
      migrationHistoryHash: computeMigrationHistoryHash(rows),
      migrationCount: 2,
      parityGate: "pass",
      classificationFk: true,
      checkedAt: "2026-06-07T00:00:00Z",
    });
  });

  it("nulls hash/count/commit when not provided (partial provenance still records the verdict)", () => {
    const rec = buildBaselineRecord({
      parityGate: "fail",
      classificationFk: false,
      checkedAt: "2026-06-07T00:00:00Z",
    });
    expect(rec.migrationHistoryHash).toBeNull();
    expect(rec.migrationCount).toBeNull();
    expect(rec.prodCommit).toBeNull();
    expect(rec.parityGate).toBe("fail");
    expect(rec.classificationFk).toBe(false);
    expect(rec.checkedAt).toBe("2026-06-07T00:00:00Z");
  });

  it("uses the caller's timestamp verbatim (no internal clock)", () => {
    const rec = buildBaselineRecord({
      parityGate: "pass",
      classificationFk: true,
      checkedAt: "1999-12-31T23:59:59Z",
    });
    expect(rec.checkedAt).toBe("1999-12-31T23:59:59Z");
  });
});
