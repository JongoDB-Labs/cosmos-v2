import { describe, it, expect } from "vitest";
import { shippedItems, statusLabelFor } from "./ceremony-payload";

const items = [
  { id: "1", ticketNumber: 115, title: "Azure gateway", columnKey: "done", storyPoints: 8 },
  { id: "2", ticketNumber: 33, title: "capacity ui", columnKey: "done", storyPoints: 2 },
  { id: "3", ticketNumber: 27, title: "postgresql17", columnKey: "done", storyPoints: 5 },
  { id: "4", ticketNumber: 14, title: "busybox", columnKey: "done", storyPoints: 8 },
  { id: "5", ticketNumber: 11, title: "webmap", columnKey: "in_progress", storyPoints: 5 },
  { id: "6", ticketNumber: 99, title: "unestimated", columnKey: "done", storyPoints: null },
];

describe("shippedItems", () => {
  it("includes only finished work", () => {
    expect(shippedItems(items).map((i) => i.id)).not.toContain("5");
  });

  it("ranks by points descending, the way the outbrief reads", () => {
    // The deck leads with the heaviest work: 8, 8, 5, 2 … not ticket order.
    expect(shippedItems(items).map((i) => i.storyPoints ?? 0)).toEqual([
      8, 8, 5, 2, 0,
    ]);
  });

  it("breaks ties by ticket number so the order is stable between renders", () => {
    // Two 8-point items: ticket 14 before ticket 115. Without a tie-break the
    // order depends on the query, and the board reshuffles on every refetch.
    const eights = shippedItems(items).filter((i) => i.storyPoints === 8);
    expect(eights.map((i) => i.ticketNumber)).toEqual([14, 115]);
  });

  it("keeps unestimated work rather than dropping it from what shipped", () => {
    // It shipped. Excluding it would understate the sprint's delivery.
    expect(shippedItems(items).map((i) => i.id)).toContain("6");
  });
});

describe("statusLabelFor", () => {
  const columns = [
    { key: "todo", name: "To Do", category: "TODO" },
    { key: "in_progress", name: "In Progress", category: "IN_PROGRESS" },
    { key: "in_review", name: "In Review", category: "IN_PROGRESS" },
  ];

  it("uses the board's own column name for the status pill", () => {
    // The deck's pills read IN REVIEW / IN PROGRESS / TO DO — the board's
    // vocabulary, not a second hardcoded set that could disagree with it.
    expect(statusLabelFor("in_review", columns)).toBe("In Review");
  });

  it("falls back to the raw key when the column has since been deleted", () => {
    expect(statusLabelFor("archived_column", columns)).toBe("archived_column");
  });
});
