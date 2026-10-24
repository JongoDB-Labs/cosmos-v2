// Coverage: actualStart/completedAt auto-capture, manual overrides and the date
// audit, on `computeItemChange` — the step every status change goes through
// (the PUT route, bulk, the assistant, merge). Moved here from the PUT route's
// prisma-mocked test when the logic moved into the change service; the
// DB-backed parity suite covers the same rules end to end through each route.
import { describe, it, expect } from "vitest";
import type { ColumnCategory, WorkItem } from "@prisma/client";
import { computeItemChange, type WorkItemPatch } from "./apply-change.server";

const NOW = new Date("2026-06-01T12:00:00.000Z");

/** Each test's destination column and the category its board gives it. */
const CATEGORY: Record<string, ColumnCategory> = {
  backlog: "TODO",
  todo: "TODO",
  "on-deck": "TODO",
  in_progress: "IN_PROGRESS",
  review: "IN_PROGRESS",
  done: "DONE",
  shipped: "DONE",
  cancelled: "CANCELLED",
};

function existing(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    title: "Original",
    description: "",
    columnKey: "todo",
    priority: "MEDIUM",
    assigneeId: null,
    intervalId: null,
    teamId: null,
    workItemTypeId: "type",
    completedAt: null,
    actualStart: null,
    startDate: null,
    dueDate: null,
    cancelReason: null,
    cancelNote: null,
    mergedIntoId: null,
    customFields: {},
    ticketNumber: 7,
    ...overrides,
  } as WorkItem;
}

function change(item: WorkItem, patch: WorkItemPatch) {
  const destCategory = patch.columnKey ? (CATEGORY[patch.columnKey] ?? null) : null;
  return computeItemChange({ existing: item, patch, destCategory, now: NOW });
}

describe("computeItemChange — actualStart/completedAt auto-capture + override", () => {
  it("1. todo → in_progress with no actualStart set auto-captures actualStart", () => {
    expect(change(existing(), { columnKey: "in_progress" }).updateData.actualStart).toBe(NOW);
  });

  it("2. already in_progress with an actualStart set → not overwritten on further moves", () => {
    const item = existing({ columnKey: "in_progress", actualStart: new Date("2026-01-01T00:00:00Z") });
    expect(change(item, { columnKey: "review" }).updateData.actualStart).toBeUndefined();
  });

  it("3. backlog → todo (still not-started) does not auto-capture actualStart", () => {
    expect(change(existing({ columnKey: "backlog" }), { columnKey: "todo" }).updateData.actualStart).toBeUndefined();
  });

  it("4. manual actualStart in the request wins over auto-capture", () => {
    const { updateData } = change(existing(), { columnKey: "in_progress", actualStart: "2026-02-02T00:00:00Z" });
    expect((updateData.actualStart as Date).toISOString()).toBe("2026-02-02T00:00:00.000Z");
  });

  it("5. manual completedAt in the request wins over auto-capture", () => {
    const { updateData } = change(existing(), { columnKey: "done", completedAt: "2026-02-05T00:00:00Z" });
    expect((updateData.completedAt as Date).toISOString()).toBe("2026-02-05T00:00:00.000Z");
  });

  // --- the 2026-08-14 incident -----------------------------------------------
  // A user moved a batch of tickets on the Sprint board and every Gantt bar
  // jumped to that day, which read as "all my start dates were reset".

  it("6. a team-named IN_PROGRESS column (Review) DOES start the clock", () => {
    expect(change(existing(), { columnKey: "review" }).updateData.actualStart).toBe(NOW);
  });

  it("7. a TODO column whose key is not in the old blocklist does NOT start the clock", () => {
    // "on-deck" is TODO but contains none of backlog/todo/to-do, so the old
    // string check treated it as started and stamped today. This is the bug.
    expect(change(existing({ columnKey: "backlog" }), { columnKey: "on-deck" }).updateData.actualStart).toBeUndefined();
  });

  it("8. a DONE column not named 'done' still captures the END date", () => {
    // "shipped" contains none of done/completed/closed.
    const item = existing({ columnKey: "in_progress", actualStart: new Date("2026-01-01") });
    expect(change(item, { columnKey: "shipped" }).updateData.completedAt).toBe(NOW);
  });

  it("9. CANCELLED never stamps a start or an end — abandoning is not delivering", () => {
    const { updateData } = change(existing(), { columnKey: "cancelled" });
    expect(updateData.actualStart).toBeUndefined();
    expect(updateData.completedAt).toBeUndefined();
  });

  it("10. an unknown column key stamps nothing rather than guessing", () => {
    expect(change(existing(), { columnKey: "mystery" }).updateData.actualStart).toBeUndefined();
  });

  it("11. leaving DONE clears the end date and keeps the start", () => {
    const item = existing({ columnKey: "done", actualStart: new Date("2026-01-01"), completedAt: new Date("2026-02-01") });
    const { updateData } = change(item, { columnKey: "todo" });
    expect(updateData.completedAt).toBeNull();
    expect(updateData.actualStart).toBeUndefined();
  });

  // --- date audit ------------------------------------------------------------
  // The incident left NO trail: activities recorded columnKey/intervalId/
  // assigneeId/workItemTypeId/title/priority and no dates at all, so the only way
  // to prove what had happened was to restore a dump and diff it.

  it("A. an AUTO-CAPTURED actualStart is written to the activity trail", () => {
    // The exact shape of the incident: the client sent only columnKey.
    const audit = change(existing(), { columnKey: "in_progress" }).trackFields.find((r) => r.field === "actualStart");
    expect(audit).toEqual({ field: "actualStart", oldVal: null, newVal: NOW.toISOString() });
  });

  it("B. an explicit startDate change is audited with both values", () => {
    const item = existing({ startDate: new Date("2026-07-27T00:00:00Z") });
    const audit = change(item, { startDate: "2026-09-01T00:00:00.000Z" }).trackFields.find((r) => r.field === "startDate");
    expect(audit).toEqual({ field: "startDate", oldVal: "2026-07-27T00:00:00.000Z", newVal: "2026-09-01T00:00:00.000Z" });
  });

  it("C. a date set to the SAME value writes no audit row", () => {
    const same = new Date("2026-07-27T00:00:00Z");
    const rows = change(existing({ startDate: same }), { startDate: same.toISOString() }).trackFields;
    expect(rows.find((r) => r.field === "startDate")).toBeUndefined();
  });

  it("D. clearing a date records the old value, so it can be restored", () => {
    const item = existing({ dueDate: new Date("2026-08-30T00:00:00Z") });
    const audit = change(item, { dueDate: null }).trackFields.find((r) => r.field === "dueDate");
    expect(audit).toEqual({ field: "dueDate", oldVal: "2026-08-30T00:00:00.000Z", newVal: null });
  });
});

describe("computeItemChange — a null status is no move", () => {
  it("columnKey: null records no move and keeps a cancel reason", () => {
    const item = existing({ columnKey: "cancelled", cancelReason: "OBE", cancelNote: "gone", completedAt: new Date("2026-02-01") });
    const { updateData, trackFields } = computeItemChange({ existing: item, patch: { columnKey: null }, destCategory: null, now: NOW });
    expect(updateData).toEqual({});
    expect(trackFields).toEqual([]);
  });
});
