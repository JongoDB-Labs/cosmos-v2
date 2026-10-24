// History prefilter SQL: scoped and parameterized whatever the spec says.
import { describe, it, expect } from "vitest";
import { historySql } from "../history.server";
import { HISTORY, type HistorySpec } from "../history";
import { FIELDS, isHistoryField } from "../fields";

const ORG = "00000000-0000-0000-0000-00000000000a";
const READABLE = ["00000000-0000-0000-0000-0000000000p1"];

describe("history prefilters", () => {
  it("the history field map is exactly the registry's history-capable fields", () => {
    expect(Object.keys(HISTORY).sort()).toEqual(FIELDS.filter((f) => isHistoryField(f.id)).map((f) => f.id).sort());
  });

  const specs: HistorySpec[] = [
    { kind: "window", field: "status", set: { values: ["done'; DROP TABLE work_items; --"], ranges: [], empty: false }, from: "2026-10-01T00:00:00.000Z", to: null },
    { kind: "window", field: "due", set: { values: [], ranges: [{ from: "2026-10-20T00:00:00.000Z", to: "2026-10-21T00:00:00.000Z" }], empty: true }, from: null, to: "2026-10-15T00:00:00.000Z" },
  ];

  it.each(specs.map((s) => [s.field, s] as const))("%s: org and readable scope are bound, values never inlined", (_f, spec) => {
    const sql = historySql(spec, ORG, READABLE);
    expect(sql.values).toContain(ORG);
    expect(sql.values).toContainEqual(READABLE);
    expect(sql.text).toMatch(/org_id = \$\d+::uuid/);
    expect(sql.text).toMatch(/project_id = ANY\(\$\d+::uuid\[\]\)/);
    expect(sql.text).toMatch(/LIMIT \$\d+/);
    expect(sql.text).not.toContain("DROP TABLE");
    expect(sql.text).not.toContain("2026-");
  });

  it("BEFORE alone never scans the org's whole history of the field", () => {
    // specs[1] has only an end. Its prefilter reads the activity since the
    // end and finds "first change" by anti-join; no DISTINCT ON over all time.
    const sql = historySql(specs[1], ORG, READABLE).text;
    expect(sql).not.toMatch(/DISTINCT ON/);
    expect(sql).toMatch(/a\.created_at >= /);
    expect(sql).toMatch(/NOT EXISTS/);
    // With a start, the window form (bounded by the start) is used.
    expect(historySql(specs[0], ORG, READABLE).text).toMatch(/a\.created_at > /);
  });
});
