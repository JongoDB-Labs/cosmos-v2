import { describe, it, expect } from "vitest";
import { isWorkItemOverdue } from "./overdue";
import type { WorkItem } from "@/types/models";

// A fixed "now" so the tests don't drift with wall-clock time.
const NOW = new Date("2026-02-01T00:00:00.000Z").getTime();
const PAST = "2026-01-15T00:00:00.000Z";
const FUTURE = "2026-03-01T00:00:00.000Z";

type OverdueInput = Pick<WorkItem, "dueDate" | "completedAt" | "columnKey">;
const base: OverdueInput = { dueDate: PAST, completedAt: null, columnKey: "todo" };

describe("isWorkItemOverdue", () => {
  // Terminal columns (DONE / CANCELLED) whose items are never "overdue".
  const resolved = new Set<string>(["done", "cancelled"]);

  it("flags an item whose planned end date has passed and isn't complete", () => {
    expect(isWorkItemOverdue(base, resolved, NOW)).toBe(true);
  });

  it("is not overdue when the due date is still in the future", () => {
    expect(isWorkItemOverdue({ ...base, dueDate: FUTURE }, resolved, NOW)).toBe(false);
  });

  it("is not overdue when there is no planned end date", () => {
    expect(isWorkItemOverdue({ ...base, dueDate: null }, resolved, NOW)).toBe(false);
  });

  it("is not overdue once completed, even if the due date is long past", () => {
    expect(
      isWorkItemOverdue({ ...base, completedAt: "2026-01-20T00:00:00.000Z" }, resolved, NOW),
    ).toBe(false);
  });

  it("is not overdue when the item sits in a terminal (done/cancelled) column", () => {
    expect(isWorkItemOverdue({ ...base, columnKey: "done" }, resolved, NOW)).toBe(false);
    expect(isWorkItemOverdue({ ...base, columnKey: "cancelled" }, resolved, NOW)).toBe(false);
  });

  it("defaults `now` to the current time (a long-past due date reads overdue)", () => {
    expect(isWorkItemOverdue(base, resolved)).toBe(true);
  });
});
