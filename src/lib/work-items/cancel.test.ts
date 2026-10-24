// COSMOS-206: a cancellation says why. OBE stands on its own; Other needs a note.
import { describe, it, expect } from "vitest";
import { cancelFieldsForUpdate, cancelInputError, cancelReasonLabel, CANCEL_NOTE_REQUIRED_MESSAGE, CANCEL_REASONS } from "./cancel";
import { activityFieldLabel, activityValueLabel } from "./activity-label";

describe("cancelInputError", () => {
  it("accepts OBE with or without a note", () => {
    expect(cancelInputError("OBE", "")).toBeNull();
    expect(cancelInputError("OBE", "Replaced by the new flow")).toBeNull();
  });

  it("requires a note for Other, ignoring whitespace", () => {
    expect(cancelInputError("OTHER", null)).toBe(CANCEL_NOTE_REQUIRED_MESSAGE);
    expect(cancelInputError("OTHER", "   ")).toBe(CANCEL_NOTE_REQUIRED_MESSAGE);
    expect(cancelInputError("OTHER", "Customer withdrew")).toBeNull();
  });
});

describe("reasons", () => {
  it("offers OBE and Other, and not Duplicate (duplicates are merged)", () => {
    expect(CANCEL_REASONS.map((r) => r.value)).toEqual(["OBE", "OTHER"]);
  });

  it("labels a reason for people, in the drawer and the activity feed", () => {
    expect(cancelReasonLabel("OBE")).toBe("Overcome by events (OBE)");
    expect(cancelReasonLabel(null)).toBeNull();
    expect(activityFieldLabel("cancelReason")).toBe("cancellation reason");
    expect(activityValueLabel("cancelReason", "OBE")).toBe("Overcome by events (OBE)");
  });
});

describe("cancelFieldsForUpdate: the reason lives as long as the cancellation", () => {
  const none = { reason: null, note: null };
  const was = { reason: "OTHER" as const, note: "Customer withdrew" };

  it("records a cancel's reason, trimming the note", () => {
    expect(
      cancelFieldsForUpdate({ requested: { reason: "OBE", note: "  moot " }, columnChanged: true, destIsCancelled: true, existing: none }),
    ).toEqual({ cancelReason: "OBE", cancelNote: "moot" });
    expect(
      cancelFieldsForUpdate({ requested: { reason: "OBE", note: "  " }, columnChanged: true, destIsCancelled: true, existing: none }),
    ).toEqual({ cancelReason: "OBE", cancelNote: null });
  });

  it("clears it when the item is reopened into another status", () => {
    expect(
      cancelFieldsForUpdate({ requested: {}, columnChanged: true, destIsCancelled: false, existing: was }),
    ).toEqual({ cancelReason: null, cancelNote: null });
  });

  it("keeps it across a move between two Cancelled statuses, and on unrelated edits", () => {
    expect(cancelFieldsForUpdate({ requested: {}, columnChanged: true, destIsCancelled: true, existing: was })).toBeUndefined();
    expect(cancelFieldsForUpdate({ requested: {}, columnChanged: false, destIsCancelled: false, existing: was })).toBeUndefined();
  });

  it("writes nothing for an ordinary move of an item that was never cancelled", () => {
    expect(cancelFieldsForUpdate({ requested: {}, columnChanged: true, destIsCancelled: false, existing: none })).toBeUndefined();
  });
});
