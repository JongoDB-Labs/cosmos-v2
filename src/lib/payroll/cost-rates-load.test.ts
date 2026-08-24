// @vitest-environment node
//
// Who gets a rate loaded is a different question for payroll than for history.
// Payroll pays the people currently employed. A P&L on last year's project was
// costed by whoever worked on it, and dropping someone who has since left makes
// that work retrospectively free — margin on finished projects quietly improves
// as staff depart, which is the worst possible direction for that error.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: { employee: { findMany: vi.fn() } },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { loadCostRateHistory } from "./cost-rates";

const ORG = "org-1";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.employee.findMany.mockResolvedValue([]);
});

const whereOf = () => prisma.employee.findMany.mock.calls[0][0].where;

describe("loadCostRateHistory — who is included", () => {
  it("loads only active employees by default", async () => {
    await loadCostRateHistory(ORG, ["u1"]);
    expect(whereOf().status).toBe("active");
  });

  it("loads former employees too when asked", async () => {
    await loadCostRateHistory(ORG, ["u1"], { includeFormerEmployees: true });
    expect(whereOf().status).toBeUndefined();
  });

  it("still scopes to the org and the users asked for", async () => {
    await loadCostRateHistory(ORG, ["u1", "u2"], { includeFormerEmployees: true });
    const w = whereOf();
    expect(w.orgId).toBe(ORG);
    expect(w.userId).toEqual({ in: ["u1", "u2"] });
  });

  it("orders each person's rates newest first, which resolveCostRate relies on", async () => {
    // resolveCostRate takes the FIRST row that has taken effect. Ascending order
    // would silently return the oldest rate the person was ever on.
    await loadCostRateHistory(ORG, ["u1"]);
    const select = prisma.employee.findMany.mock.calls[0][0].select;
    expect(select.costRates.orderBy).toEqual({ effectiveFrom: "desc" });
  });
});
