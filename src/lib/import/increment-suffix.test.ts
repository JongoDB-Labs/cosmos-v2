// A planning workbook writes a later increment after the status:
// "Proposed · PI-3". The status imported blank and the PI was lost. The split
// is pure, so the shapes a sheet may use are pinned here; the database side
// (status mapped, PI resolved to a Program Increment) is in
// entity-import.deliverable.db.test.ts.
import { describe, expect, it } from "vitest";
import { getEntityDef, splitIncrementSuffix } from "./entity-fields";
import { mapRows } from "./entity-import";

describe("splitIncrementSuffix", () => {
  it.each([
    ["Proposed · PI-3", "Proposed", "PI-3"],
    ["Proposed·PI-3", "Proposed", "PI-3"],
    ["Proposed • PI 3", "Proposed", "PI 3"],
    ["Proposed | PI3", "Proposed", "PI3"],
    ["Proposed - PI-12", "Proposed", "PI-12"],
    ["Proposed — PI-3", "Proposed", "PI-3"],
    ["Planned (PI-2)", "Planned", "PI-2"],
    ["  In-Progress · pi-4  ", "In-Progress", "pi-4"],
  ])("%j → %j + %j", (raw, value, increment) => {
    expect(splitIncrementSuffix(raw)).toEqual({ value, increment });
  });

  it.each([
    "Planned",
    "In-Progress",
    "Not-Started",
    // Only an increment: nothing would be left to match as a status.
    "PI-3",
    // Not a PI: an increment needs a number.
    "Proposed · PIE",
    "",
  ])("leaves %j whole", (raw) => {
    expect(splitIncrementSuffix(raw)).toEqual({ value: raw, increment: null });
  });
});

describe("a deliverable row's Status cell", () => {
  const def = getEntityDef("deliverable")!;

  it('maps "Proposed · PI-3" to NOT_STARTED and carries "PI-3" to the interval', () => {
    const [row] = mapRows(def, {
      entity: "deliverable",
      mode: "validate",
      mapping: { ID: "code", Title: "title", Status: "status" },
      rows: [{ ID: "D-1", Title: "A row", Status: "Proposed · PI-3" }],
    });
    expect(row.fields).toMatchObject({ status: "NOT_STARTED", intervalId: "PI-3" });
    expect(row.incrementFrom).toEqual({ intervalId: "Status" });
    expect(row.warnings).toEqual([]);
  });

  it("does not let a blank Sprint cell wipe the PI, nor the PI replace a named sprint", () => {
    const rows = mapRows(def, {
      entity: "deliverable",
      mode: "validate",
      mapping: { ID: "code", Title: "title", Status: "status", Sprint: "intervalId" },
      rows: [
        { ID: "D-2", Title: "Blank sprint", Status: "Proposed · PI-3", Sprint: "" },
        { ID: "D-3", Title: "Named sprint", Status: "Proposed · PI-3", Sprint: "Sprint 7" },
      ],
    });
    expect(rows.map((r) => [r.fields.intervalId, r.incrementFrom])).toEqual([
      ["PI-3", { intervalId: "Status" }],
      ["Sprint 7", undefined],
    ]);
  });
});
