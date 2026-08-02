// @vitest-environment node
//
// `resolveSubmitGate` — the gate against real data.
//
// Two properties matter here and neither is visible in the pure function: it
// must FAIL OPEN (a database hiccup must not stop somebody recording hours),
// and it must not do the expensive org-wide lookup when an earlier exemption
// already decides the answer — this runs on every time-tracking page load.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma, hasSupervisor, assignableSupervisors } = vi.hoisted(() => ({
  prisma: { employee: { findFirst: vi.fn() } },
  hasSupervisor: vi.fn(),
  assignableSupervisors: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/org/supervisors", () => ({ hasSupervisor }));
vi.mock("@/lib/org/assignable-supervisors", () => ({ assignableSupervisors }));

import { resolveSubmitGate } from "./submit-gate";

const ORG = "org-1";
const ME = "user-1";

const resolve = (canApproveOwnTime = false) =>
  resolveSubmitGate({ orgId: ORG, subjectUserId: ME, canApproveOwnTime });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.employee.findFirst.mockResolvedValue({ id: "emp-1" });
  hasSupervisor.mockResolvedValue(false);
  assignableSupervisors.mockResolvedValue([
    { employeeId: "emp-2", userId: "user-2", displayName: "Bob", canApprove: true },
  ]);
});

describe("resolveSubmitGate", () => {
  it("BLOCKS an unsupervised employee, and returns who may be asked", async () => {
    const gate = await resolve();

    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe("SUPERVISOR_REQUIRED");
    // The modal opens off this, so an empty list here is a dead end.
    expect(gate.eligible).toHaveLength(1);
  });

  it("skips the org-wide lookup when they already have a supervisor", async () => {
    // The hot path. assignableSupervisors loads EVERY employee and EVERY
    // supervisor edge in the org, and the answer cannot depend on it here.
    hasSupervisor.mockResolvedValue(true);

    const gate = await resolve();

    expect(gate.allowed).toBe(true);
    expect(assignableSupervisors).not.toHaveBeenCalled();
  });

  it("skips the lookup when they can approve their own time", async () => {
    const gate = await resolve(true);

    expect(gate.allowed).toBe(true);
    expect(assignableSupervisors).not.toHaveBeenCalled();
  });

  it("skips the lookup when they have no employee record", async () => {
    // Nothing to look up against — supervision is employee-to-employee.
    prisma.employee.findFirst.mockResolvedValue(null);

    const gate = await resolve();

    expect(gate.allowed).toBe(true);
    expect(assignableSupervisors).not.toHaveBeenCalled();
  });

  it("ALLOWS when the org has nobody who could supervise them", async () => {
    // The lookup does happen here — it is what decides the answer — and comes
    // back empty. Blocking would lock the whole org out of recording time.
    assignableSupervisors.mockResolvedValue([]);

    const gate = await resolve();

    expect(assignableSupervisors).toHaveBeenCalled();
    expect(gate.allowed).toBe(true);
  });

  it("FAILS OPEN when the database is unreachable", async () => {
    // Deliberately permissive. This is a data-hygiene control, not a security
    // one: a false allow costs an unrouted week (the status quo before it
    // existed), while a false block stops somebody recording hours they worked.
    hasSupervisor.mockRejectedValue(new Error("db down"));

    const gate = await resolve();

    expect(gate.allowed).toBe(true);
    expect(gate.eligible).toEqual([]);
  });

  it("fails open when the CANDIDATE lookup is what breaks", async () => {
    // The other half of the same rule — the failure can come from either query.
    assignableSupervisors.mockRejectedValue(new Error("db down"));

    expect((await resolve()).allowed).toBe(true);
  });
});
