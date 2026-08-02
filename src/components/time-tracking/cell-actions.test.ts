// @vitest-environment node
//
// What right-clicking a day in the week grid offers.
//
// Removing an entry used to exist only in List view, so correcting a mis-logged
// day meant switching views to do it — the grid is where you notice the mistake,
// so it should be where you can fix it.
import { describe, it, expect, vi } from "vitest";
import { cellActions } from "./time-tracker";
import type { TimeEntry } from "@/types/models";

const entry = (over: Partial<TimeEntry> = {}) =>
  ({
    id: "e1",
    hours: 2.5,
    description: "Radar integration",
    status: "DRAFT",
    date: "2026-07-30",
    billableType: "BILLABLE",
    ...over,
  }) as unknown as TimeEntry;

/** Every label the menu would show, flattened. */
const labels = (groups: ReturnType<typeof cellActions>) =>
  groups.flatMap((g) => g.items.map((i) => i.label));

const noop = () => {};

describe("cellActions", () => {
  it("offers Edit and Remove for a draft entry, plus logging another", () => {
    const out = cellActions("2026-07-30", [entry()], noop, noop, noop);
    expect(labels(out)).toEqual(["Edit", "Remove", "Log time on this day"]);
  });

  it("DISAMBIGUATES when a day holds several entries", () => {
    // "Remove" is a dangerous word when the user cannot tell which of three
    // rows it means, so each carries its hours and description.
    const out = cellActions(
      "2026-07-30",
      [entry(), entry({ id: "e2", hours: 4, description: "Standup" })],
      noop,
      noop,
      noop,
    );
    expect(labels(out)).toEqual([
      "Edit 2.50h — Radar integration",
      "Remove 2.50h — Radar integration",
      "Edit 4.00h — Standup",
      "Remove 4.00h — Standup",
      "Log time on this day",
    ]);
  });

  it("keeps labels short when there is only ONE entry", () => {
    // The disambiguation is noise when there is nothing to disambiguate.
    const out = cellActions("2026-07-30", [entry()], noop, noop, noop);
    expect(labels(out)).not.toContain("Edit 2.50h — Radar integration");
  });

  it("offers nothing destructive on a SUBMITTED entry", () => {
    // A submitted period is closed to edits and the server refuses them —
    // offering the action would produce an error the user did not earn.
    const out = cellActions(
      "2026-07-30",
      [entry({ status: "SUBMITTED" })],
      noop,
      noop,
      noop,
    );
    expect(labels(out)).toEqual(["Log time on this day"]);
  });

  it("offers only logging on an empty day", () => {
    expect(labels(cellActions("2026-07-30", [], noop, noop, noop))).toEqual([
      "Log time on this day",
    ]);
  });

  it("offers NOTHING when the week is read-only", () => {
    // Viewing a colleague's week. ActionMenu renders no menu for empty groups,
    // so a supervisor never gets a right-click that would act on someone else.
    expect(
      cellActions("2026-07-30", [entry()], undefined, undefined, undefined),
    ).toEqual([]);
  });

  it("wires Remove to the entry that was actually clicked", () => {
    const onDelete = vi.fn();
    const out = cellActions(
      "2026-07-30",
      [entry(), entry({ id: "e2", hours: 4 })],
      noop,
      onDelete,
      noop,
    );
    // Second entry's Remove — the off-by-one that would delete the wrong row.
    const removeSecond = out[1].items.find((i) => i.label.startsWith("Remove"))!;
    removeSecond.onClick?.();
    expect(onDelete).toHaveBeenCalledWith("e2");
  });

  it("wires Log time to THIS day, not today", () => {
    const onCellClick = vi.fn();
    const out = cellActions("2026-07-30", [], noop, noop, onCellClick);
    out[0].items[0].onClick?.();
    expect(onCellClick).toHaveBeenCalledWith("2026-07-30");
  });
});
