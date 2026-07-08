import { describe, it, expect } from "vitest";
import { pickNext, type QueueItem } from "./queue";

const mk = (n: number, priority: QueueItem["priority"], columnKey: string, columnEnteredAt: string): QueueItem =>
  ({ id: `id${n}`, ticketNumber: n, priority, columnKey, columnEnteredAt });

describe("pickNext", () => {
  it("returns null when nothing is in a TODO column", () => {
    expect(pickNext([mk(1, "HIGH", "in-progress", "2026-01-01T00:00:00Z")])).toBeNull();
  });
  it("prefers higher priority", () => {
    const got = pickNext([
      mk(1, "LOW", "todo", "2026-01-01T00:00:00Z"),
      mk(2, "CRITICAL", "backlog", "2026-01-02T00:00:00Z"),
    ]);
    expect(got?.ticketNumber).toBe(2);
  });
  it("breaks ties by oldest columnEnteredAt", () => {
    const got = pickNext([
      mk(1, "MEDIUM", "backlog", "2026-01-05T00:00:00Z"),
      mk(2, "MEDIUM", "todo", "2026-01-02T00:00:00Z"),
    ]);
    expect(got?.ticketNumber).toBe(2);
  });
});
