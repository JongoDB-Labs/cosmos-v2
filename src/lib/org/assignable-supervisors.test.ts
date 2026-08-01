// @vitest-environment node
//
// Who may be OFFERED as a supervisor. The grandfathering case here is a real
// bug caught by opening the actual page: restricting candidates to TIME_APPROVE
// holders made an EXISTING supervisor vanish from the picker, which also made
// the record unsaveable — the unchanged set contained an id the server would no
// longer accept.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma, approversInOrg } = vi.hoisted(() => ({
  prisma: {
    employee: { findMany: vi.fn() },
    employeeSupervisor: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
  approversInOrg: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/time/routing", () => ({ approversInOrg }));

import {
  assignableSupervisors,
  supervisorPickerOptions,
  descendantsOf,
} from "./assignable-supervisors";

const ORG = "11111111-1111-1111-1111-111111111111";
const ALICE_EMP = "aaaa0000-0000-0000-0000-000000000001";
const BOSS_EMP = "aaaa0000-0000-0000-0000-000000000002";
const REPORT_EMP = "aaaa0000-0000-0000-0000-000000000003";
const ALICE_USER = "bbbb0000-0000-0000-0000-000000000001";
const BOSS_USER = "bbbb0000-0000-0000-0000-000000000002";
const REPORT_USER = "bbbb0000-0000-0000-0000-000000000003";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findMany.mockImplementation(
    async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id, displayName: `User ${id.slice(-1)}` })),
  );
});

describe("assignableSupervisors", () => {
  it("offers only people who can approve time", async () => {
    approversInOrg.mockResolvedValue([BOSS_USER]);
    prisma.employee.findMany.mockResolvedValue([
      { id: ALICE_EMP, userId: ALICE_USER },
      { id: BOSS_EMP, userId: BOSS_USER },
      { id: REPORT_EMP, userId: REPORT_USER },
    ]);
    prisma.employeeSupervisor.findMany.mockResolvedValue([]);

    const out = await assignableSupervisors(ORG, ALICE_EMP);

    expect(out.map((c) => c.employeeId)).toEqual([BOSS_EMP]);
    expect(out[0].canApprove).toBe(true);
  });

  it("never offers the employee themselves", async () => {
    approversInOrg.mockResolvedValue([ALICE_USER, BOSS_USER]);
    prisma.employee.findMany.mockResolvedValue([
      { id: ALICE_EMP, userId: ALICE_USER },
      { id: BOSS_EMP, userId: BOSS_USER },
    ]);
    prisma.employeeSupervisor.findMany.mockResolvedValue([]);

    const out = await assignableSupervisors(ORG, ALICE_EMP);
    expect(out.map((c) => c.employeeId)).not.toContain(ALICE_EMP);
  });

  it("never offers someone who reports up through this employee", async () => {
    // Choosing them would close a loop. The server refuses it anyway; keeping
    // it out of the picker means the common case is never an error to undo.
    approversInOrg.mockResolvedValue([REPORT_USER]);
    prisma.employee.findMany.mockResolvedValue([
      { id: ALICE_EMP, userId: ALICE_USER },
      { id: REPORT_EMP, userId: REPORT_USER },
    ]);
    prisma.employeeSupervisor.findMany.mockResolvedValue([
      { employeeId: REPORT_EMP, supervisorId: ALICE_EMP },
    ]);

    const out = await assignableSupervisors(ORG, ALICE_EMP);
    expect(out).toEqual([]);
  });
});

describe("supervisorPickerOptions", () => {
  it("KEEPS an existing supervisor who cannot approve, and marks them", async () => {
    // The bug this exists for: without it the current supervisor disappears
    // from the list, the picker claims nobody can approve, and saving the
    // unchanged set is refused.
    approversInOrg.mockResolvedValue([]); // nobody holds TIME_APPROVE
    prisma.employee.findMany.mockImplementation(
      async (args: { where: { id?: { in: string[] } } }) =>
        args.where.id
          ? [{ id: BOSS_EMP, userId: BOSS_USER }]
          : [
              { id: ALICE_EMP, userId: ALICE_USER },
              { id: BOSS_EMP, userId: BOSS_USER },
            ],
    );
    prisma.employeeSupervisor.findMany.mockResolvedValue([
      { employeeId: ALICE_EMP, supervisorId: BOSS_EMP },
    ]);

    const { options, addableIds } = await supervisorPickerOptions(ORG, ALICE_EMP);

    expect(options.map((o) => o.employeeId)).toEqual([BOSS_EMP]);
    expect(options[0].canApprove).toBe(false);
    // …but they are NOT addable — the restriction still governs new names.
    expect(addableIds).toEqual([]);
  });

  it("does not duplicate a supervisor who DOES qualify", async () => {
    approversInOrg.mockResolvedValue([BOSS_USER]);
    prisma.employee.findMany.mockResolvedValue([
      { id: ALICE_EMP, userId: ALICE_USER },
      { id: BOSS_EMP, userId: BOSS_USER },
    ]);
    prisma.employeeSupervisor.findMany.mockResolvedValue([
      { employeeId: ALICE_EMP, supervisorId: BOSS_EMP },
    ]);

    const { options } = await supervisorPickerOptions(ORG, ALICE_EMP);
    expect(options).toHaveLength(1);
    expect(options[0].canApprove).toBe(true);
  });
});

describe("descendantsOf", () => {
  it("follows the chart down through several levels", () => {
    const edges = [
      { employeeId: "b", supervisorId: "a" },
      { employeeId: "c", supervisorId: "b" },
    ];
    expect([...descendantsOf(edges, "a")].sort()).toEqual(["b", "c"]);
  });

  it("terminates on data that is ALREADY cyclic", () => {
    const edges = [
      { employeeId: "b", supervisorId: "a" },
      { employeeId: "a", supervisorId: "b" },
    ];
    expect([...descendantsOf(edges, "a")].sort()).toEqual(["a", "b"]);
  });
});
