// COSMOS-206: a project's Cancelled status is created the first time something
// in it is cancelled, on every board that has a workflow, without clobbering a
// column a team already named "cancelled".
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";
import { ensureCancelledColumn } from "./cancel.server";

const tx = {
  boardColumn: { findMany: vi.fn(), createMany: vi.fn() },
  board: { findMany: vi.fn() },
};
const run = (preferred?: string) =>
  ensureCancelledColumn(tx as unknown as Prisma.TransactionClient, "p1", preferred);

beforeEach(() => vi.clearAllMocks());

describe("ensureCancelledColumn", () => {
  it("reuses the project's existing Cancelled status", async () => {
    tx.boardColumn.findMany.mockResolvedValue([{ key: "abandoned" }]);
    expect(await run()).toBe("abandoned");
    expect(tx.boardColumn.createMany).not.toHaveBeenCalled();
  });

  it("keeps the column asked for when it is one of the project's Cancelled ones", async () => {
    tx.boardColumn.findMany.mockResolvedValue([{ key: "abandoned" }, { key: "wont-do" }]);
    expect(await run("wont-do")).toBe("wont-do");
    // ...but never a column that isn't a Cancelled one.
    expect(await run("done")).toBe("abandoned");
  });

  it("adds Cancelled at the end of each board with a workflow when there is none", async () => {
    tx.boardColumn.findMany.mockResolvedValue([]);
    tx.board.findMany.mockResolvedValue([
      { id: "b1", columns: [{ key: "todo", sortOrder: 0 }, { key: "done", sortOrder: 4 }] },
      { id: "b2", columns: [{ key: "open", sortOrder: 2 }] },
    ]);
    expect(await run()).toBe("cancelled");
    expect(tx.board.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p1", columns: { some: {} } } }),
    );
    expect(tx.boardColumn.createMany).toHaveBeenCalledWith({
      // Two first cancels racing in one project insert the same key; the loser skips.
      skipDuplicates: true,
      data: [
        expect.objectContaining({ boardId: "b1", key: "cancelled", name: "Cancelled", category: "CANCELLED", sortOrder: 5 }),
        expect.objectContaining({ boardId: "b2", key: "cancelled", name: "Cancelled", category: "CANCELLED", sortOrder: 3 }),
      ],
    });
  });

  it("picks a fresh key when a board already uses 'cancelled' for something else", async () => {
    tx.boardColumn.findMany.mockResolvedValue([]);
    tx.board.findMany.mockResolvedValue([
      { id: "b1", columns: [{ key: "cancelled", sortOrder: 0 }, { key: "cancelled-2", sortOrder: 1 }] },
    ]);
    expect(await run()).toBe("cancelled-3");
  });

  it("creates nothing in a project whose boards have no columns", async () => {
    tx.boardColumn.findMany.mockResolvedValue([]);
    tx.board.findMany.mockResolvedValue([]);
    expect(await run()).toBe("cancelled");
    expect(tx.boardColumn.createMany).not.toHaveBeenCalled();
  });
});
