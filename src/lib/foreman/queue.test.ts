import { describe, it, expect } from "vitest";
import { pickNext, type QueueItem } from "./queue";

const mk = (n: number, priority: QueueItem["priority"], columnKey: string, columnEnteredAt: string): QueueItem =>
  ({ id: `id${n}`, ticketNumber: n, priority, columnKey, columnEnteredAt });

describe("pickNext", () => {
  it("returns null when nothing is in a TODO column", () => {
    expect(pickNext([mk(1, "HIGH", "in-progress", "2026-01-01T00:00:00Z")])).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(pickNext([])).toBeNull();
  });

  it("todo tier outranks backlog regardless of priority", () => {
    const items: QueueItem[] = [
      { id: "a", ticketNumber: 1, priority: "CRITICAL", columnKey: "backlog", columnEnteredAt: "2026-07-01T00:00:00Z" },
      { id: "b", ticketNumber: 2, priority: "LOW", columnKey: "todo", columnEnteredAt: "2026-07-10T00:00:00Z" },
    ];
    expect(pickNext(items)?.id).toBe("b");
  });

  it("within todo, higher priority wins, then FIFO by columnEnteredAt", () => {
    const byPriority = pickNext([
      mk(1, "LOW", "todo", "2026-01-01T00:00:00Z"),
      mk(2, "CRITICAL", "todo", "2026-01-02T00:00:00Z"),
    ]);
    expect(byPriority?.ticketNumber).toBe(2);

    const byFifo = pickNext([
      mk(3, "MEDIUM", "todo", "2026-01-05T00:00:00Z"),
      mk(4, "MEDIUM", "todo", "2026-01-02T00:00:00Z"),
    ]);
    expect(byFifo?.ticketNumber).toBe(4);
  });

  it("all-backlog input behaves exactly as today: priority then FIFO (the fallback)", () => {
    const byPriority = pickNext([
      mk(1, "LOW", "backlog", "2026-01-01T00:00:00Z"),
      mk(2, "CRITICAL", "backlog", "2026-01-02T00:00:00Z"),
    ]);
    expect(byPriority?.ticketNumber).toBe(2);

    const byFifo = pickNext([
      mk(3, "MEDIUM", "backlog", "2026-01-05T00:00:00Z"),
      mk(4, "MEDIUM", "backlog", "2026-01-02T00:00:00Z"),
    ]);
    expect(byFifo?.ticketNumber).toBe(4);
  });
});
