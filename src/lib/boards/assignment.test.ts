// COSMOS-51 — the shared "Assigned to me" predicate. Every board view's
// quick-filter delegates to this one function, so "me" resolves identically
// across Backlog, Roadmap, Table, and Calendar.
import { describe, it, expect } from "vitest";
import { isAssignedTo } from "./assignment";
import type { WorkItem } from "@/types/models";

const asItem = (o: Record<string, unknown>) => o as unknown as WorkItem;

describe("isAssignedTo", () => {
  it("matches the primary assignee", () => {
    expect(isAssignedTo(asItem({ assigneeId: "me" }), "me")).toBe(true);
    expect(isAssignedTo(asItem({ assigneeId: "other" }), "me")).toBe(false);
  });

  it("matches any member of the multi-assignee set", () => {
    expect(
      isAssignedTo(
        asItem({ assigneeId: "other", assignees: [{ userId: "me" }] }),
        "me",
      ),
    ).toBe(true);
  });

  it("is false for an unassigned item", () => {
    expect(isAssignedTo(asItem({ assigneeId: null }), "me")).toBe(false);
    expect(
      isAssignedTo(asItem({ assigneeId: null, assignees: [] }), "me"),
    ).toBe(false);
  });
});
