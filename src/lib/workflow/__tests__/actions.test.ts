import { describe, it, expect } from "vitest";
import { applyActions, applyInput } from "../actions";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const base = { item: { createdById: "bob", assigneeId: "carol", tags: ["Security"] }, actorId: "alice", now: NOW };

describe("applyActions", () => {
  it("folds field actions into the patch, after the person's own values", () => {
    const { patch } = applyActions(
      [
        { kind: "setField", field: { system: "resolution" }, value: { literal: "Fixed" } },
        { kind: "setField", field: { custom: "closed_on" }, value: { now: true } },
        { kind: "clearField", field: { system: "dueDate" } },
      ],
      { ...base, patch: { columnKey: "done", resolution: "Won't do", customFields: { a: 1 } } },
    );
    expect(patch).toEqual({
      columnKey: "done",
      resolution: "Fixed",
      customFields: { a: 1, closed_on: NOW.toISOString() },
      dueDate: null,
    });
  });

  it("assigns, replacing a multi-assign set in the same request", () => {
    expect(applyActions([{ kind: "assign", to: "actor" }], { ...base, patch: { assigneeIds: ["x", "y"] } }).patch).toEqual({
      assigneeId: "alice",
    });
    expect(applyActions([{ kind: "assign", to: "creator" }], { ...base, patch: {} }).patch.assigneeId).toBe("bob");
    expect(applyActions([{ kind: "assign", to: "unassigned" }], { ...base, patch: {} }).patch.assigneeId).toBeNull();
  });

  it("adds and removes labels case-insensitively against the item's current set", () => {
    const { patch } = applyActions(
      [
        { kind: "addLabels", labels: ["security", "triaged"] },
        { kind: "removeLabels", labels: ["SECURITY"] },
      ],
      { ...base, patch: {} },
    );
    expect(patch.tags).toEqual(["triaged"]);
  });

  it("returns comments and watchers as side writes, the assignee after any assign", () => {
    const r = applyActions(
      [
        { kind: "assign", to: { userId: "11111111-1111-1111-1111-111111111111" } },
        { kind: "addWatcher", who: "assignee" },
        { kind: "addWatcher", who: "actor" },
        { kind: "addComment", body: "Resolved by workflow" },
      ],
      { ...base, patch: {} },
    );
    expect(r.watchers).toEqual(["11111111-1111-1111-1111-111111111111", "alice"]);
    expect(r.comments).toEqual(["Resolved by workflow"]);
  });
});

describe("applyInput", () => {
  it("takes only the fields the transition asks for", () => {
    const patch = applyInput(
      { columnKey: "done" },
      [{ field: { system: "resolution" } }, { field: { custom: "root_cause" } }],
      { "system:resolution": "Fixed", "custom:root_cause": "race", "system:assigneeId": "smuggled" },
    );
    expect(patch).toEqual({ columnKey: "done", resolution: "Fixed", customFields: { root_cause: "race" } });
  });

  it("maps the cancel reason and note onto the patch", () => {
    expect(
      applyInput({}, [{ field: { system: "cancelReason" } }, { field: { system: "cancelNote" } }], {
        "system:cancelReason": "OTHER",
        "system:cancelNote": "superseded",
      }),
    ).toEqual({ cancelReason: "OTHER", cancelNote: "superseded" });
  });
});
