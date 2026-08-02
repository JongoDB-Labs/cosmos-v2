// @vitest-environment node
//
// What the Submit button promises before it is pressed.
//
// This exists because `canSubmit` and `reason` NEARLY INVERT EACH OTHER, and
// the old hint keyed off the wrong one. `reason: "none"` — nobody in the org can
// approve at all — is an EXEMPTION and submits fine; `reason: "admin_pool"` —
// approvers exist, none supervises you — is the blocked case. A hint that reads
// them the intuitive way round tells every blocked worker they may submit and
// every exempt worker that they may not.
import { describe, it, expect } from "vitest";
import { submitHint } from "./time-tracker";

describe("submitHint", () => {
  it("warns that pressing it opens a request, when submission is BLOCKED", () => {
    const hint = submitHint(
      { reason: "admin_pool", approverNames: ["Bob"], canSubmit: false },
      false,
    );
    // Naming the consequence, not just the refusal: the button does something
    // useful when pressed, and saying so is what makes it a next step.
    expect(hint).toMatch(/supervisor/i);
    expect(hint).toMatch(/ask/i);
  });

  it("does NOT claim the week goes to the approver pool when blocked", () => {
    // The regression this guards: `admin_pool` with named approvers used to
    // produce "Goes to Bob for approval", which is a promise the server refuses.
    const hint = submitHint(
      { reason: "admin_pool", approverNames: ["Bob"], canSubmit: false },
      false,
    );
    expect(hint).not.toMatch(/goes to Bob/i);
  });

  it("says the week will reach nobody when the org has no approvers at all", () => {
    // Allowed — this is the exemption — but the worker still needs to know the
    // week will sit. Two different messages for two different situations.
    const hint = submitHint(
      { reason: "none", approverNames: [], canSubmit: true },
      false,
    );
    expect(hint).toMatch(/nobody/i);
    expect(hint).toMatch(/can still submit/i);
  });

  it("names the approver on the ordinary path", () => {
    expect(
      submitHint(
        { reason: "manager", approverNames: ["Bob", "Carol"], canSubmit: true },
        false,
      ),
    ).toBe("Goes to Bob, Carol for approval.");
  });

  it("puts 'log some time first' ahead of everything else", () => {
    // An empty week is why the button is disabled, so it is what the tooltip
    // has to explain — a supervisor warning there would be a red herring.
    expect(
      submitHint(
        { reason: "admin_pool", approverNames: [], canSubmit: false },
        true,
      ),
    ).toBe("Log some time first");
  });

  it("stays permissive when the server did not say (an older deployment)", () => {
    // canSubmit absent must not read as false, or a client that briefly runs
    // against the previous image blocks a button the server would accept.
    const hint = submitHint(
      { reason: "manager", approverNames: ["Bob"] },
      false,
    );
    expect(hint).toBe("Goes to Bob for approval.");
  });

  it("has nothing to say before the route is known", () => {
    expect(submitHint(null, false)).toBeUndefined();
  });
});
