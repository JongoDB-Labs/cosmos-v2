import { describe, it, expect } from "vitest";
import {
  submitTransition,
  approveTransition,
  rejectTransition,
  entryStatusFor,
  approvalAuthority,
} from "./approval";
import type { TimesheetStatus } from "@prisma/client";

const SINGLE_LANE = { requireCostApproval: false };
const TWO_LANE = { requireCostApproval: true };
const ALL: TimesheetStatus[] = [
  "OPEN",
  "SUBMITTED",
  "LABOR_APPROVED",
  "APPROVED",
  "REJECTED",
  "LOCKED",
];

describe("submitTransition", () => {
  it("OPEN can be submitted", () => {
    expect(submitTransition("OPEN")).toEqual({ ok: true, next: "SUBMITTED" });
  });

  it("a REJECTED timesheet can be fixed and resubmitted", () => {
    // Rejection has to be recoverable or a rejected week is a dead end.
    expect(submitTransition("REJECTED")).toEqual({ ok: true, next: "SUBMITTED" });
  });

  it("refuses double submission", () => {
    expect(submitTransition("SUBMITTED").ok).toBe(false);
    expect(submitTransition("LABOR_APPROVED").ok).toBe(false);
  });

  it("refuses APPROVED and LOCKED", () => {
    expect(submitTransition("APPROVED").ok).toBe(false);
    expect(submitTransition("LOCKED").ok).toBe(false);
  });

  it("every status yields a decision — no undefined fallthrough", () => {
    for (const s of ALL) expect(typeof submitTransition(s).ok).toBe("boolean");
  });
});

describe("approveTransition — single lane", () => {
  it("labor approval completes the timesheet outright", () => {
    expect(approveTransition("SUBMITTED", "labor", SINGLE_LANE)).toEqual({
      ok: true,
      next: "APPROVED",
    });
  });

  it("the cost lane is refused when the org does not use it", () => {
    // Otherwise a caller could drive a lane the org has switched off.
    expect(approveTransition("SUBMITTED", "cost", SINGLE_LANE).ok).toBe(false);
  });
});

describe("approveTransition — two lanes", () => {
  it("labor approval parks the sheet awaiting cost", () => {
    expect(approveTransition("SUBMITTED", "labor", TWO_LANE)).toEqual({
      ok: true,
      next: "LABOR_APPROVED",
    });
  });

  it("cost approval then completes it", () => {
    expect(approveTransition("LABOR_APPROVED", "cost", TWO_LANE)).toEqual({
      ok: true,
      next: "APPROVED",
    });
  });

  it("cost CANNOT jump ahead of labor", () => {
    // "chargeable to my project" must never be asserted about hours nobody has
    // confirmed were worked.
    const r = approveTransition("SUBMITTED", "cost", TWO_LANE);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/labor approval is required/i);
  });

  it("labor cannot be given twice", () => {
    expect(approveTransition("LABOR_APPROVED", "labor", TWO_LANE).ok).toBe(false);
  });
});

describe("approveTransition — invariants across every status", () => {
  it("an unsubmitted timesheet can never be approved by either lane", () => {
    for (const lane of ["labor", "cost"] as const) {
      for (const config of [SINGLE_LANE, TWO_LANE]) {
        expect(approveTransition("OPEN", lane, config).ok).toBe(false);
        expect(approveTransition("REJECTED", lane, config).ok).toBe(false);
      }
    }
  });

  it("APPROVED and LOCKED are terminal for approval", () => {
    for (const lane of ["labor", "cost"] as const) {
      for (const config of [SINGLE_LANE, TWO_LANE]) {
        expect(approveTransition("APPROVED", lane, config).ok).toBe(false);
        expect(approveTransition("LOCKED", lane, config).ok).toBe(false);
      }
    }
  });
});

describe("rejectTransition", () => {
  it("sends a submitted timesheet back to the worker", () => {
    expect(rejectTransition("SUBMITTED")).toEqual({ ok: true, next: "REJECTED" });
  });

  it("can reject after labor approval but before cost", () => {
    expect(rejectTransition("LABOR_APPROVED")).toEqual({ ok: true, next: "REJECTED" });
  });

  it("an APPROVED timesheet cannot be rejected", () => {
    // Reversing an approval is a correction with its own record, not a
    // rejection. Silently reopening approved hours is the thing an audit trail
    // exists to prevent.
    const r = rejectTransition("APPROVED");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/approved/i);
  });

  it("an unsubmitted timesheet has nothing to reject", () => {
    expect(rejectTransition("OPEN").ok).toBe(false);
  });
});

describe("entryStatusFor — keeps burn.ts and payroll working untouched", () => {
  it("maps approval to APPROVED, which is what money queries filter on", () => {
    expect(entryStatusFor("APPROVED")).toBe("APPROVED");
    expect(entryStatusFor("LOCKED")).toBe("APPROVED");
  });

  it("maps mid-approval states to SUBMITTED, NOT approved", () => {
    // The trap: LABOR_APPROVED contains the word approved but is only half
    // done. Treating it as APPROVED would bill hours the cost owner has not
    // accepted against a contract.
    expect(entryStatusFor("SUBMITTED")).toBe("SUBMITTED");
    expect(entryStatusFor("LABOR_APPROVED")).toBe("SUBMITTED");
  });

  it("maps worker-owned states back to DRAFT", () => {
    expect(entryStatusFor("OPEN")).toBe("DRAFT");
    expect(entryStatusFor("REJECTED")).toBe("DRAFT");
  });

  it("never returns APPROVED for anything short of full approval", () => {
    const approvedFrom = ALL.filter((s) => entryStatusFor(s) === "APPROVED");
    expect(approvedFrom.sort()).toEqual(["APPROVED", "LOCKED"]);
  });
});

describe("approvalAuthority", () => {
  const ME = "me", THEM = "them";

  it("a manager may approve their report", () => {
    expect(
      approvalAuthority({
        actorUserId: ME, subjectUserId: THEM,
        hasTimeApprove: false, isManagerOfSubject: true, subjectHasManager: true,
      }).allowed,
    ).toBe(true);
  });

  it("TIME_APPROVE alone is enough for someone else's timesheet", () => {
    expect(
      approvalAuthority({
        actorUserId: ME, subjectUserId: THEM,
        hasTimeApprove: true, isManagerOfSubject: false, subjectHasManager: false,
      }).allowed,
    ).toBe(true);
  });

  it("a plain member may not approve anyone", () => {
    expect(
      approvalAuthority({
        actorUserId: ME, subjectUserId: THEM,
        hasTimeApprove: false, isManagerOfSubject: false, subjectHasManager: true,
      }).allowed,
    ).toBe(false);
  });

  it("refuses SELF-approval when the person has a supervisor", () => {
    // Someone else is designated; approving your own hours bypasses them.
    // Holding TIME_APPROVE does not buy past this.
    const r = approvalAuthority({
      actorUserId: ME, subjectUserId: ME,
      hasTimeApprove: true, isManagerOfSubject: false, subjectHasManager: true,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/supervisor/i);
  });

  it("ALLOWS self-approval when the person has no supervisor", () => {
    // The top of an org chart has nobody above it; refusing would deadlock —
    // their hours could never be approved, so never billed.
    expect(
      approvalAuthority({
        actorUserId: ME, subjectUserId: ME,
        hasTimeApprove: true, isManagerOfSubject: false, subjectHasManager: false,
      }).allowed,
    ).toBe(true);
  });

  it("no supervisor AND no permission is still a refusal", () => {
    // The deadlock escape must not become a way in for anyone.
    expect(
      approvalAuthority({
        actorUserId: ME, subjectUserId: ME,
        hasTimeApprove: false, isManagerOfSubject: false, subjectHasManager: false,
      }).allowed,
    ).toBe(false);
  });
});
