import { describe, it, expect } from "vitest";
import { parseCSV } from "@/lib/export/csv";
import { timeEntriesToCsv, timeCsvFilename, TIME_CSV_COLUMNS, type ExportableTimeEntry } from "./entries-csv";

const names = {
  project: (id: string) => ({ p1: "Dry Dock" })[id],
  clin: (id: string) => ({ c1: "0001 — Engineering" })[id],
};

function entry(over: Partial<ExportableTimeEntry> = {}): ExportableTimeEntry {
  return {
    date: "2026-10-20T00:00:00.000Z",
    hours: 8,
    billedHours: null,
    projectId: "p1",
    clinId: "c1",
    description: "Pairing on the importer",
    billableType: "BILLABLE",
    status: "DRAFT",
    tags: [],
    ...over,
  };
}

describe("timeEntriesToCsv", () => {
  it("writes names and labels, not ids or enum values", () => {
    const { headers, rows } = parseCSV(timeEntriesToCsv([entry()], names));

    expect(headers).toEqual([...TIME_CSV_COLUMNS]);
    expect(rows[0]).toEqual({
      Date: "2026-10-20",
      Hours: "8",
      "Billed hours": "8",
      Project: "Dry Dock",
      CLIN: "0001 — Engineering",
      Description: "Pairing on the importer",
      Billable: "Billable",
      Status: "Draft",
      Tags: "",
    });
  });

  it("bills the override when one was set, including a deliberate zero", () => {
    const { rows } = parseCSV(
      timeEntriesToCsv([entry({ billedHours: 6 }), entry({ date: "2026-10-21", billedHours: 0 })], names),
    );

    expect(rows.map((r) => r["Billed hours"])).toEqual(["6", "0"]);
  });

  it("orders rows by date, oldest first", () => {
    const { rows } = parseCSV(
      timeEntriesToCsv([entry({ date: "2026-10-22" }), entry({ date: "2026-10-19" })], names),
    );

    expect(rows.map((r) => r.Date)).toEqual(["2026-10-19", "2026-10-22"]);
  });

  it("keeps a description with commas, quotes and newlines in one cell", () => {
    const description = 'Fixed "the" bug, then\nwrote it up';
    const { rows } = parseCSV(timeEntriesToCsv([entry({ description })], names));

    expect(rows).toHaveLength(1);
    expect(rows[0].Description).toBe(description);
  });

  it("leaves project and CLIN blank when unset or unknown", () => {
    const { rows } = parseCSV(
      timeEntriesToCsv([entry({ projectId: null, clinId: "gone", tags: ["a", "b"] })], names),
    );

    expect(rows[0].Project).toBe("");
    expect(rows[0].CLIN).toBe("");
    expect(rows[0].Tags).toBe("a; b");
  });

  it("still writes the header row when there is nothing to export", () => {
    expect(timeEntriesToCsv([], names)).toBe(TIME_CSV_COLUMNS.join(","));
  });
});

describe("timeCsvFilename", () => {
  it("slugs the person and the range", () => {
    expect(timeCsvFilename("Steve Katzman", "Oct 19 – Oct 25, 2026")).toBe(
      "time-steve-katzman-oct-19-oct-25-2026.csv",
    );
  });
});
