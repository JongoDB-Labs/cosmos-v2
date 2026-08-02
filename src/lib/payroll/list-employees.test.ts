// @vitest-environment node
//
// The payroll list flags who is waiting on a supervisor.
//
// This flag is the ONLY standing signpost for an outstanding request. The
// person asked gets a notification, but a notification is read once and then
// gone — and anyone arriving at the payroll screen any other way had no way to
// know a request was waiting. Without it the request flow is write-only.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    employee: { findMany: vi.fn() },
    supervisorRequest: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { listEmployees } from "./service";

const ORG = "org-1";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.employee.findMany.mockResolvedValue([
    { id: "emp-asked", userId: "u1" },
    { id: "emp-quiet", userId: "u2" },
  ]);
  prisma.supervisorRequest.findMany.mockResolvedValue([
    { employeeId: "emp-asked" },
  ]);
});

describe("listEmployees", () => {
  it("flags the employee who has asked, and only them", async () => {
    const rows = await listEmployees(ORG);

    expect(rows.find((r) => r.id === "emp-asked")?.awaitingSupervisor).toBe(true);
    // The negative matters as much: a flag on every row is a flag on none.
    expect(rows.find((r) => r.id === "emp-quiet")?.awaitingSupervisor).toBe(false);
  });

  it("keeps every employee field intact", async () => {
    // The screen renders rates and status from these rows; decorating must not
    // become filtering.
    const rows = await listEmployees(ORG);

    expect(rows).toHaveLength(2);
    expect(rows[0].userId).toBe("u1");
  });

  it("asks the database for ONE row per employee, not one per request", async () => {
    // Several people can ask the same person. Without `distinct` a worker who
    // asked three approvers would appear three times in the lookup — harmless
    // for a Set, wasteful over a real org, and a trap for anyone who later
    // counts these rows.
    await listEmployees(ORG);

    expect(prisma.supervisorRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ distinct: ["employeeId"] }),
    );
  });

  it("scopes the request lookup to the org", async () => {
    // Multi-tenant: an unscoped read would flag employees using another
    // tenant's rows.
    await listEmployees(ORG);

    expect(prisma.supervisorRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: ORG } }),
    );
  });

  it("flags nobody when there are no open requests", async () => {
    prisma.supervisorRequest.findMany.mockResolvedValue([]);

    const rows = await listEmployees(ORG);

    expect(rows.every((r) => r.awaitingSupervisor === false)).toBe(true);
  });
});
