// @vitest-environment node
//
// The gate that refuses a timesheet from someone with no supervisor.
//
// Nearly every test here is about an EXEMPTION rather than the block, and that
// is the right proportion: the block is trivial and the exemptions are what stop
// it locking people out of recording their own time.
import { describe, it, expect } from "vitest";
import { submitGate } from "./submit-gate";

/** The blocked shape: an employee, unsupervised, in an org that has approvers. */
const blocked = {
  hasSupervisor: false,
  isEmployee: true,
  canApproveOwnTime: false,
  eligibleSupervisorCount: 3,
};

describe("submitGate", () => {
  // ── The exemption that prevents a company-wide lockout ────────────────────
  //
  // Written first, deliberately. An org part-way through the rollout — employee
  // records created, nobody granted Reviewer/Approver yet — has zero eligible
  // supervisors for everyone. If the block fires there, all 26 people are
  // refused, every request modal opens empty, and nobody can record time again
  // until someone fixes it from OUTSIDE the product.
  it("ALLOWS when the org has nobody who could supervise them", () => {
    expect(submitGate({ ...blocked, eligibleSupervisorCount: 0 }).allowed).toBe(
      true,
    );
  });

  it("still allows when the org has nobody AND they cannot self-approve", () => {
    // The two dangerous conditions together — an ordinary member in an org with
    // no approvers at all. This is the exact state of a fresh organisation.
    expect(
      submitGate({
        hasSupervisor: false,
        isEmployee: true,
        canApproveOwnTime: false,
        eligibleSupervisorCount: 0,
      }).allowed,
    ).toBe(true);
  });

  // ── The exemption that prevents the org chart deadlocking at the top ──────
  it("ALLOWS someone who can approve their own time", () => {
    // An OWNER has nobody above them. Blocking them means they could never
    // submit at all, and it buys nothing: approvalAuthority already lets them
    // sign their own week precisely because no supervisor exists.
    expect(submitGate({ ...blocked, canApproveOwnTime: true }).allowed).toBe(
      true,
    );
  });

  // ── The exemption for people who cannot be supervised at all ──────────────
  it("ALLOWS someone with no employee record", () => {
    // employee_supervisors joins two Employee ids, so there is nowhere to write
    // the assignment. The block would be unsatisfiable from inside the product.
    expect(submitGate({ ...blocked, isEmployee: false }).allowed).toBe(true);
  });

  // ── The ordinary allow ────────────────────────────────────────────────────
  it("ALLOWS someone who already has a supervisor", () => {
    expect(submitGate({ ...blocked, hasSupervisor: true }).allowed).toBe(true);
  });

  it("allows a supervised worker even when nobody else could be named", () => {
    // Their supervisor may have since lost TIME_APPROVE, emptying the candidate
    // list. That must not retroactively block a worker who HAS a supervisor.
    expect(
      submitGate({
        ...blocked,
        hasSupervisor: true,
        eligibleSupervisorCount: 0,
      }).allowed,
    ).toBe(true);
  });

  // ── The block itself ──────────────────────────────────────────────────────
  it("BLOCKS an unsupervised employee when somebody could supervise them", () => {
    const gate = submitGate(blocked);
    expect(gate.allowed).toBe(false);
  });

  it("carries a machine-readable code, not just prose", () => {
    // The client opens the request-a-supervisor modal off this code. Matching
    // the message instead would break silently the first time it is reworded.
    expect(submitGate(blocked).code).toBe("SUPERVISOR_REQUIRED");
  });

  it("explains what to do, not just that it failed", () => {
    // A refusal the worker cannot act on is a dead end — the same reason a
    // rejection requires a reason.
    expect(submitGate(blocked).reason).toMatch(/supervisor/i);
  });

  it("attaches no code when it allows", () => {
    // An allow carrying a block code would open the modal on a successful
    // submission.
    const gate = submitGate({ ...blocked, hasSupervisor: true });
    expect(gate.code).toBeUndefined();
  });

  it("blocks on the boundary of exactly ONE eligible supervisor", () => {
    // Guards an off-by-one in the count check: one candidate is enough to ask.
    expect(
      submitGate({ ...blocked, eligibleSupervisorCount: 1 }).allowed,
    ).toBe(false);
  });
});
