import { describe, it, expect, vi } from "vitest";
import { StatusFieldWriteError, updateWorkItems, type WorkItemDb } from "./write.server";
import { RECORDED_BY_CALLER } from "./events.server";

/** A client that records the writes it is asked for. */
function fakeDb() {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  return { db: { workItem: { updateMany } } as unknown as WorkItemDb, updateMany };
}

describe("updateWorkItems", () => {
  it("refuses a status field: status changes go through applyWorkItemChange", async () => {
    for (const data of [{ columnKey: "done" }, { completedAt: new Date() }, { cancelReason: "OBE" as const }]) {
      const { db, updateMany } = fakeDb();
      await expect(updateWorkItems(db, ["a"], data, RECORDED_BY_CALLER)).rejects.toBeInstanceOf(StatusFieldWriteError);
      expect(updateMany).not.toHaveBeenCalled();
    }
  });

  it("writes other fields to every given item", async () => {
    const { db, updateMany } = fakeDb();
    await updateWorkItems(db, ["a", "b"], { intervalId: null }, RECORDED_BY_CALLER);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] } }, data: { intervalId: null } });
  });
});
