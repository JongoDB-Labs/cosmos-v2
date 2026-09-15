// @vitest-environment node
//
// A rate change has to be RECORDED, not just overwritten.
//
// `employees.cost_rate` is still written, because it is what "what does this
// person cost today" reads. But if that were the only write, entering a raise
// would re-cost every hour that person has ever logged — closed phases, posted
// margins, the lot. The history row is what confines the new rate to the days
// it actually applies to.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    employee: {
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    employeeCostRate: { upsert: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { updateEmployee } from "./service";
import { utcToday } from "./cost-rates";

const ORG = "org-1";
const EMP = "emp-1";
const ACTOR = "user-9";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.employee.updateMany.mockResolvedValue({ count: 1 });
  prisma.employee.findUniqueOrThrow.mockResolvedValue({ id: EMP });
  prisma.employeeCostRate.upsert.mockResolvedValue({});
});

describe("updateEmployee — rate changes", () => {
  it("records the new rate as taking effect today", async () => {
    await updateEmployee(ORG, EMP, { costRate: 120 }, ACTOR);

    expect(prisma.employeeCostRate.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.employeeCostRate.upsert.mock.calls[0][0];
    expect(call.where.employeeId_effectiveFrom.employeeId).toBe(EMP);
    expect(call.where.employeeId_effectiveFrom.effectiveFrom.getTime()).toBe(utcToday().getTime());
    expect(call.create.costRate.toString()).toBe("120");
    expect(call.create.createdById).toBe(ACTOR);
  });

  it("still writes the scalar, so 'what do they cost today' stays correct", async () => {
    await updateEmployee(ORG, EMP, { costRate: 120 }, ACTOR);

    const { data } = prisma.employee.updateMany.mock.calls[0][0];
    expect(data.costRate.toString()).toBe("120");
  });

  it("upserts rather than creates, so a same-day correction wins instead of colliding", async () => {
    // One rate per person per day is a unique constraint. Fixing a typo minutes
    // later must overwrite, not throw.
    await updateEmployee(ORG, EMP, { costRate: 120 }, ACTOR);
    const call = prisma.employeeCostRate.upsert.mock.calls[0][0];
    expect(call.update.costRate.toString()).toBe("120");
  });

  it("records nothing when the update does not touch the rate", async () => {
    await updateEmployee(ORG, EMP, { laborCategory: "Engineer" }, ACTOR);
    expect(prisma.employeeCostRate.upsert).not.toHaveBeenCalled();
  });

  it("records nothing when the employee was not found", async () => {
    prisma.employee.updateMany.mockResolvedValue({ count: 0 });
    await expect(updateEmployee(ORG, EMP, { costRate: 120 }, ACTOR)).rejects.toThrow();
    expect(prisma.employeeCostRate.upsert).not.toHaveBeenCalled();
  });
});
