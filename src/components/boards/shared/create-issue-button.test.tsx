// @vitest-environment jsdom
// COSMOS-80: a work item created from the RAID log used to land "Unclassified"
// because the shared create dialog never submitted a RAID tag. The dialog now
// accepts a category preset and folds the chosen value into the POST body's
// `tags`. `buildCreateBody` is the pure seam that decides what gets submitted —
// tested here without driving the base-ui dialog.
import { describe, it, expect } from "vitest";
import { buildCreateBody, type CreateIssueFields } from "./create-issue-button";

const base: CreateIssueFields = {
  title: "  Investigate outage  ",
  workItemTypeId: "type-1",
  columnKey: "todo",
  priority: "HIGH",
  assigneeIds: [],
  intervalId: null,
  startDate: "",
  dueDate: "",
  tags: [],
};

describe("buildCreateBody", () => {
  it("trims the title and always carries type + column + priority", () => {
    expect(buildCreateBody(base)).toMatchObject({
      title: "Investigate outage",
      workItemTypeId: "type-1",
      columnKey: "todo",
      priority: "HIGH",
    });
  });

  it("submits a RAID category preset as the item's tags (COSMOS-80)", () => {
    // The RAID log seeds a category, so a new entry lands in a real column
    // instead of "Unclassified".
    expect(buildCreateBody({ ...base, tags: ["risk"] }).tags).toEqual(["risk"]);
  });

  it("omits tags entirely when no preset is chosen (other board views)", () => {
    expect(buildCreateBody({ ...base, tags: [] })).not.toHaveProperty("tags");
  });

  it("falls back to the bare TASK type before the types fetch resolves", () => {
    const body = buildCreateBody({ ...base, workItemTypeId: "" });
    expect(body).not.toHaveProperty("workItemTypeId");
    expect(body.type).toBe("TASK");
  });

  it("includes optional assignees/interval/dates only when set", () => {
    const full = buildCreateBody({
      ...base,
      assigneeIds: ["u1", "u2"],
      intervalId: "c1",
      startDate: "2026-07-01",
      dueDate: "2026-07-10",
    });
    expect(full.assigneeIds).toEqual(["u1", "u2"]);
    expect(full.intervalId).toBe("c1");
    expect(full.startDate).toBe("2026-07-01T00:00:00.000Z");
    expect(full.dueDate).toBe("2026-07-10T00:00:00.000Z");

    const bare = buildCreateBody(base);
    for (const k of ["assigneeIds", "intervalId", "startDate", "dueDate"]) {
      expect(bare).not.toHaveProperty(k);
    }
  });
});
