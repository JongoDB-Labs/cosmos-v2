// @vitest-environment node
//
// The org chart is a GRAPH now, not a chain. The cycle guard is the part most
// likely to be subtly wrong: the old single-parent walk followed ONE edge per
// hop, which cannot see a loop that closes through a second supervisor.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => {
  const tx = {
    employeeSupervisor: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  };
  return {
    prisma: {
      __tx: tx,
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      employeeSupervisor: { findMany: vi.fn(), findFirst: vi.fn() },
      employee: { findFirst: vi.fn() },
    },
  };
});
vi.mock("@/lib/db/client", () => ({ prisma }));

import {
  supervisorUserIdsOf,
  hasSupervisor,
  isSupervisorOf,
  assertNoSupervisorCycle,
  setSupervisors,
} from "./supervisors";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "99999999-9999-9999-9999-999999999999";
const WORKER = "22222222-2222-2222-2222-222222222222";
const BOSS = "33333333-3333-3333-3333-333333333333";
const DEPUTY = "44444444-4444-4444-4444-444444444444";

beforeEach(() => vi.clearAllMocks());

describe("supervisorUserIdsOf", () => {
  it("returns every supervisor, not just one", async () => {
    prisma.employeeSupervisor.findMany.mockResolvedValue([
      { supervisor: { userId: BOSS, orgId: ORG } },
      { supervisor: { userId: DEPUTY, orgId: ORG } },
    ]);
    await expect(supervisorUserIdsOf(ORG, WORKER)).resolves.toEqual([
      BOSS,
      DEPUTY,
    ]);
  });

  it("refuses a supervisor belonging to ANOTHER org", async () => {
    // The supervisor row is reached through a bare FK, so a cross-tenant
    // pointer is representable. Routing to it would leak one org's timesheet
    // into another's approval queue.
    prisma.employeeSupervisor.findMany.mockResolvedValue([
      { supervisor: { userId: BOSS, orgId: OTHER_ORG } },
    ]);
    await expect(supervisorUserIdsOf(ORG, WORKER)).resolves.toEqual([]);
  });

  it("drops a self-supervision edge", async () => {
    // It names nobody, and treating it as a supervisor deadlocks the sheet.
    prisma.employeeSupervisor.findMany.mockResolvedValue([
      { supervisor: { userId: WORKER, orgId: ORG } },
    ]);
    await expect(supervisorUserIdsOf(ORG, WORKER)).resolves.toEqual([]);
  });

  it("fails CLOSED to the approver pool when the lookup throws", async () => {
    prisma.employeeSupervisor.findMany.mockRejectedValue(new Error("db down"));
    await expect(supervisorUserIdsOf(ORG, WORKER)).resolves.toEqual([]);
  });
});

describe("hasSupervisor", () => {
  it("is false when the only edge is self-supervision", async () => {
    prisma.employeeSupervisor.findMany.mockResolvedValue([
      { supervisor: { userId: WORKER } },
    ]);
    await expect(hasSupervisor(ORG, WORKER)).resolves.toBe(false);
  });

  it("is true with a real supervisor", async () => {
    prisma.employeeSupervisor.findMany.mockResolvedValue([
      { supervisor: { userId: BOSS } },
    ]);
    await expect(hasSupervisor(ORG, WORKER)).resolves.toBe(true);
  });

  it("fails SAFE toward the stricter rule when the lookup throws", async () => {
    // Assume one exists, which REFUSES self-approval rather than granting it.
    prisma.employeeSupervisor.findMany.mockRejectedValue(new Error("db down"));
    await expect(hasSupervisor(ORG, WORKER)).resolves.toBe(true);
  });
});

describe("isSupervisorOf", () => {
  it("is true when an edge exists", async () => {
    prisma.employeeSupervisor.findFirst.mockResolvedValue({ id: "x" });
    await expect(isSupervisorOf(ORG, BOSS, WORKER)).resolves.toBe(true);
  });

  it("is false with no edge", async () => {
    prisma.employeeSupervisor.findFirst.mockResolvedValue(null);
    await expect(isSupervisorOf(ORG, BOSS, WORKER)).resolves.toBe(false);
  });

  it("is false for yourself, without even querying", async () => {
    await expect(isSupervisorOf(ORG, WORKER, WORKER)).resolves.toBe(false);
    expect(prisma.employeeSupervisor.findFirst).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the lookup throws", async () => {
    prisma.employeeSupervisor.findFirst.mockRejectedValue(new Error("db down"));
    await expect(isSupervisorOf(ORG, BOSS, WORKER)).resolves.toBe(false);
  });
});

describe("assertNoSupervisorCycle", () => {
  /** Mock the upward walk: employeeIds -> their supervisors. */
  function chart(edges: Record<string, string[]>) {
    prisma.employeeSupervisor.findMany.mockImplementation(
      async (args: { where: { employeeId: { in: string[] } } }) =>
        args.where.employeeId.in.flatMap((id) =>
          (edges[id] ?? []).map((supervisorId) => ({ supervisorId })),
        ),
    );
  }

  it("refuses self-supervision outright", async () => {
    await expect(assertNoSupervisorCycle(ORG, WORKER, WORKER)).rejects.toThrow(
      /own supervisor/i,
    );
  });

  it("allows an ordinary assignment", async () => {
    chart({ [BOSS]: [] });
    await expect(
      assertNoSupervisorCycle(ORG, WORKER, BOSS),
    ).resolves.toBeUndefined();
  });

  it("refuses a direct loop", async () => {
    chart({ [BOSS]: [WORKER] });
    await expect(assertNoSupervisorCycle(ORG, WORKER, BOSS)).rejects.toThrow(
      /already reports to/i,
    );
  });

  it("catches a loop that closes through a SECOND supervisor", async () => {
    // The case a single-parent walk misses entirely: BOSS's first supervisor is
    // innocent, and the loop hides behind the second one.
    chart({ [BOSS]: ["innocent", DEPUTY], [DEPUTY]: [WORKER], innocent: [] });
    await expect(assertNoSupervisorCycle(ORG, WORKER, BOSS)).rejects.toThrow(
      /already reports to/i,
    );
  });

  it("terminates on data that is ALREADY cyclic", async () => {
    // Never assume stored rows are acyclic just because the write path checks.
    chart({ [BOSS]: [DEPUTY], [DEPUTY]: [BOSS] });
    await expect(
      assertNoSupervisorCycle(ORG, WORKER, BOSS),
    ).resolves.toBeUndefined();
  });
});

describe("setSupervisors", () => {
  beforeEach(() => {
    prisma.employee.findFirst.mockResolvedValue({ id: "ok" });
    prisma.employeeSupervisor.findMany.mockResolvedValue([]); // acyclic
  });

  it("reports what it ADDED and REMOVED, so one audit record can describe it", async () => {
    prisma.__tx.employeeSupervisor.findMany.mockResolvedValue([
      { supervisorId: BOSS },
      { supervisorId: "gone" },
    ]);

    const result = await setSupervisors({
      orgId: ORG,
      employeeId: WORKER,
      supervisorIds: [BOSS, DEPUTY],
      actorId: "actor",
    });

    expect(result).toEqual({ added: [DEPUTY], removed: ["gone"] });
  });

  it("does not touch rows that are already correct", async () => {
    prisma.__tx.employeeSupervisor.findMany.mockResolvedValue([
      { supervisorId: BOSS },
    ]);

    await setSupervisors({
      orgId: ORG,
      employeeId: WORKER,
      supervisorIds: [BOSS],
      actorId: "actor",
    });

    expect(prisma.__tx.employeeSupervisor.createMany).not.toHaveBeenCalled();
    expect(prisma.__tx.employeeSupervisor.deleteMany).not.toHaveBeenCalled();
  });

  it("clearing every supervisor removes them all", async () => {
    prisma.__tx.employeeSupervisor.findMany.mockResolvedValue([
      { supervisorId: BOSS },
    ]);

    const result = await setSupervisors({
      orgId: ORG,
      employeeId: WORKER,
      supervisorIds: [],
      actorId: "actor",
    });

    expect(result.removed).toEqual([BOSS]);
    expect(prisma.__tx.employeeSupervisor.deleteMany).toHaveBeenCalled();
  });

  it("stamps who made the assignment", async () => {
    prisma.__tx.employeeSupervisor.findMany.mockResolvedValue([]);

    await setSupervisors({
      orgId: ORG,
      employeeId: WORKER,
      supervisorIds: [BOSS],
      actorId: "actor-1",
    });

    const call = prisma.__tx.employeeSupervisor.createMany.mock.calls.at(-1)?.[0] as {
      data: Array<{ createdById: string }>;
    };
    expect(call.data[0].createdById).toBe("actor-1");
  });

  it("refuses the whole change if ANY proposed supervisor is not in this org", async () => {
    // Validated before the transaction opens, so a rejected member cannot leave
    // the chart half-applied.
    prisma.employee.findFirst.mockResolvedValue(null);

    await expect(
      setSupervisors({
        orgId: ORG,
        employeeId: WORKER,
        supervisorIds: [BOSS],
        actorId: "actor",
      }),
    ).rejects.toThrow(/not an employee of this org/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
