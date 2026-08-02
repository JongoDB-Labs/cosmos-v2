// @vitest-environment node
//
// The Staffing sheet must not carry a pay rate the caller may not see.
//
// The arch test next door asserts that call sites CONSULT FINANCE_READ. This
// asserts the other half — that the answer actually reaches the spreadsheet.
// Both are needed: a call site can compute `includeCost` correctly and still
// write the rate if the flag is dropped on the way down, which is a one-word
// mistake nobody would see in review.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";

const { prisma, loadStaffing, loadClinsWithBurn, loadMilestonesWithDerived } =
  vi.hoisted(() => ({
    prisma: {
      risk: { findMany: vi.fn() },
      changeRequest: { findMany: vi.fn() },
      blocker: { findMany: vi.fn() },
      deliverable: { findMany: vi.fn() },
      contract: { findMany: vi.fn() },
    },
    loadStaffing: vi.fn(),
    loadClinsWithBurn: vi.fn(),
    loadMilestonesWithDerived: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("./staffing", () => ({ loadStaffing }));
vi.mock("./burn", () => ({ loadClinsWithBurn }));
vi.mock("./schedule", () => ({ loadMilestonesWithDerived }));

import { buildProjectWorkbook } from "./export";

const ORG = "org-1";
const PROJ = "proj-1";

/** One staffed person. `costRate` is what loadStaffing would have returned. */
const staffRow = (costRate: number | null) => ({
  id: "s1",
  userId: "u1",
  name: "Alice",
  role: "MANAGER",
  allocationPercent: 100,
  laborCategory: "Sr Engineer",
  clearance: null,
  employmentType: "SALARY",
  costRate,
  onContract: true,
  cacStatus: "Current",
  cacExpiry: null,
  trainingStatus: "Complete",
  accessStatus: "Active",
  ndaStatus: "Executed",
  complianceNotes: null,
  compliant: true,
});

/** The Staffing sheet, as rows of plain objects. */
function staffingSheet(buf: Buffer): Record<string, unknown>[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  return XLSX.utils.sheet_to_json(wb.Sheets["Staffing"]);
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of Object.values(prisma)) m.findMany.mockResolvedValue([]);
  loadClinsWithBurn.mockResolvedValue([]);
  loadMilestonesWithDerived.mockResolvedValue([]);
});

describe("buildProjectWorkbook — cost rate", () => {
  it("asks loadStaffing to WITHHOLD the rate when the caller may not see it", () => {
    // The original bug in one assertion: this argument was the literal `true`,
    // so the workbook carried every pay rate regardless of who asked.
    loadStaffing.mockResolvedValue([staffRow(null)]);

    return buildProjectWorkbook(ORG, PROJ, { includeCost: false }).then(() => {
      expect(loadStaffing).toHaveBeenCalledWith(ORG, PROJ, {
        includeCost: false,
      });
    });
  });

  it("passes the permission THROUGH rather than deciding for itself", async () => {
    loadStaffing.mockResolvedValue([staffRow(125)]);

    await buildProjectWorkbook(ORG, PROJ, { includeCost: true });

    expect(loadStaffing).toHaveBeenCalledWith(ORG, PROJ, { includeCost: true });
  });

  it("writes a BLANK Cost Rate cell, not a null, when withheld", async () => {
    // The half the arch test cannot see. A withheld rate arrives as null, and
    // rendering that as the string "null" would leak nothing but would tell the
    // reader a rate exists — and a stray `String(s.costRate)` would print it.
    loadStaffing.mockResolvedValue([staffRow(null)]);

    const rows = staffingSheet(
      await buildProjectWorkbook(ORG, PROJ, { includeCost: false }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].Person).toBe("Alice");
    // sheet_to_json omits empty cells entirely — the column carries nothing.
    expect(rows[0]["Cost Rate"] ?? "").toBe("");
  });

  it("still writes the rate for a finance-cleared caller", async () => {
    // The control. Without this the test above passes against a workbook that
    // dropped the column entirely, which would be a different bug.
    loadStaffing.mockResolvedValue([staffRow(125)]);

    const rows = staffingSheet(
      await buildProjectWorkbook(ORG, PROJ, { includeCost: true }),
    );

    expect(rows[0]["Cost Rate"]).toBe(125);
  });
});
