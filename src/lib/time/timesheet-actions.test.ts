// @vitest-environment node
//
// What a transition WRITES. The state machine (approval.ts) decides the next
// status; this decides the stamps that go with it, and those stamps are the
// audit record — a wrong one is worse than a missing one.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => {
  const tx = {
    timesheet: { update: vi.fn() },
    timeEntry: { updateMany: vi.fn() },
  };
  return {
    prisma: {
      __tx: tx,
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      employee: { findFirst: vi.fn() },
    },
  };
});

vi.mock("@/lib/db/client", () => ({ prisma }));

import { applyTimesheetTransition } from "./timesheet-actions";

const ORG = "11111111-1111-1111-1111-111111111111";
const SHEET = "22222222-2222-2222-2222-222222222222";
const ACTOR = "33333333-3333-3333-3333-333333333333";

/** The `data` handed to timesheet.update on the last transition. */
function sheetData(): Record<string, unknown> {
  const call = prisma.__tx.timesheet.update.mock.calls.at(-1);
  if (!call) throw new Error("timesheet.update was never called");
  return (call[0] as { data: Record<string, unknown> }).data;
}
function entryData(): Record<string, unknown> {
  const call = prisma.__tx.timeEntry.updateMany.mock.calls.at(-1);
  if (!call) throw new Error("timeEntry.updateMany was never called");
  return (call[0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.__tx.timesheet.update.mockResolvedValue({ id: SHEET });
  prisma.__tx.timeEntry.updateMany.mockResolvedValue({ count: 1 });
});

describe("applyTimesheetTransition — SUBMITTED", () => {
  it("stamps submittedAt and clears any previous rejection", async () => {
    await applyTimesheetTransition({ orgId: ORG, timesheetId: SHEET, next: "SUBMITTED", actorId: ACTOR });

    expect(sheetData().submittedAt).toBeInstanceOf(Date);
    // A stale reason shown against a resubmitted week reads as a fresh complaint.
    expect(sheetData().rejectedReason).toBeNull();
  });
});

describe("applyTimesheetTransition — OPEN (withdrawn)", () => {
  it("CLEARS submittedAt", async () => {
    // The sheet was never handed over, so it must not look like it was. A stale
    // submittedAt makes the next submission look like a duplicate.
    await applyTimesheetTransition({ orgId: ORG, timesheetId: SHEET, next: "OPEN", actorId: ACTOR });

    expect(sheetData().submittedAt).toBeNull();
  });

  it("sets no rejection reason — withdrawing is not a rejection", async () => {
    await applyTimesheetTransition({ orgId: ORG, timesheetId: SHEET, next: "OPEN", actorId: ACTOR });

    expect(sheetData().rejectedReason).toBeNull();
  });

  it("returns entries to DRAFT and clears any approver", async () => {
    await applyTimesheetTransition({ orgId: ORG, timesheetId: SHEET, next: "OPEN", actorId: ACTOR });

    expect(entryData().status).toBe("DRAFT");
    expect(entryData().approvedById).toBeNull();
  });

  it("excludes voided entries from the sweep", async () => {
    await applyTimesheetTransition({ orgId: ORG, timesheetId: SHEET, next: "OPEN", actorId: ACTOR });

    const where = (prisma.__tx.timeEntry.updateMany.mock.calls.at(-1)?.[0] as {
      where: Record<string, unknown>;
    }).where;
    // Withdrawn hours must not drag voided rows back into the workflow.
    expect(where.voidedAt).toBeNull();
  });
});

describe("applyTimesheetTransition — APPROVED", () => {
  it("records the approver on the lane AND on the entries", async () => {
    await applyTimesheetTransition({
      orgId: ORG, timesheetId: SHEET, next: "APPROVED", actorId: ACTOR, lane: "labor",
    });

    expect(sheetData().laborApprovedById).toBe(ACTOR);
    expect(sheetData().laborApprovedAt).toBeInstanceOf(Date);
    expect(entryData().status).toBe("APPROVED");
    expect(entryData().approvedById).toBe(ACTOR);
  });
});

describe("applyTimesheetTransition — REJECTED", () => {
  it("keeps the reason and clears BOTH approval stamps", async () => {
    // Otherwise a later re-approval inherits a signature from the round that
    // was rejected.
    await applyTimesheetTransition({
      orgId: ORG, timesheetId: SHEET, next: "REJECTED", actorId: ACTOR,
      rejectedReason: "Thursday looks like a duplicate",
    });

    expect(sheetData().rejectedReason).toBe("Thursday looks like a duplicate");
    expect(sheetData().laborApprovedById).toBeNull();
    expect(sheetData().costApprovedById).toBeNull();
    expect(entryData().status).toBe("DRAFT");
  });
});
