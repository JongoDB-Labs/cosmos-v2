import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  bareTypeKey,
  isTypeNestingValid,
  validateParentAssignment,
} from "./hierarchy";

const ORG = "org-1";
const PROJECT = "proj-1";
const CHILD = "child-1";
const PARENT = "parent-1";
const CHILD_TYPE = "childType-1";

/** A hand-built prisma stand-in exposing just the delegates the helper touches. */
type DbMock = {
  workItem: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  workItemType: { findUnique: ReturnType<typeof vi.fn> };
};
function makeDb(): DbMock {
  return {
    workItem: { findFirst: vi.fn(), findUnique: vi.fn() },
    workItemType: { findUnique: vi.fn() },
  };
}
const asDb = (db: DbMock) => db as unknown as Pick<PrismaClient, "workItem" | "workItemType">;

describe("bareTypeKey", () => {
  it("strips the sector prefix and lowercases", () => {
    expect(bareTypeKey("software.Task")).toBe("task");
    expect(bareTypeKey("manufacturing.work_order")).toBe("work_order");
  });
  it("returns null for empty input", () => {
    expect(bareTypeKey(null)).toBeNull();
    expect(bareTypeKey(undefined)).toBeNull();
    expect(bareTypeKey("")).toBeNull();
  });
});

describe("isTypeNestingValid", () => {
  it("allows a child strictly below its parent in the hierarchy", () => {
    expect(isTypeNestingValid("software.epic", "software.story")).toBe(true);
    expect(isTypeNestingValid("software.story", "software.task")).toBe(true);
    expect(isTypeNestingValid("software.task", "software.subtask")).toBe(true);
    expect(isTypeNestingValid("software.story", "software.subtask")).toBe(true);
  });
  it("rejects an inverted or same-level pairing", () => {
    expect(isTypeNestingValid("software.task", "software.story")).toBe(false); // inverted
    expect(isTypeNestingValid("software.story", "software.epic")).toBe(false); // inverted
    expect(isTypeNestingValid("software.epic", "software.epic")).toBe(false); // same level
  });
  it("does not opine on types outside the known hierarchy", () => {
    expect(isTypeNestingValid("manufacturing.work_order", "manufacturing.operation")).toBe(true);
    expect(isTypeNestingValid("software.epic", "custom.whatever")).toBe(true);
  });
});

describe("validateParentAssignment", () => {
  it("rejects an item as its own parent (no DB calls needed)", async () => {
    const db = makeDb();
    const res = await validateParentAssignment({
      db: asDb(db),
      orgId: ORG,
      projectId: PROJECT,
      parentId: CHILD,
      childId: CHILD,
      childTypeId: CHILD_TYPE,
    });
    expect(res).toEqual({ status: 400, error: "An item can't be its own parent." });
    expect(db.workItem.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a parent that isn't in the same project", async () => {
    const db = makeDb();
    db.workItem.findFirst.mockResolvedValue(null); // scoped lookup finds nothing
    const res = await validateParentAssignment({
      db: asDb(db),
      orgId: ORG,
      projectId: PROJECT,
      parentId: PARENT,
      childId: CHILD,
      childTypeId: CHILD_TYPE,
    });
    expect(res).toEqual({ status: 400, error: "Parent item not found in this project." });
  });

  it("rejects a circular reference (parent is a descendant of the item)", async () => {
    const db = makeDb();
    // proposed parent → A → child (child is an ancestor of the parent already)
    db.workItem.findFirst.mockResolvedValue({
      id: PARENT,
      parentId: "A",
      workItemType: { key: "software.task", name: "Task" },
    });
    db.workItem.findUnique.mockResolvedValueOnce({ parentId: CHILD }); // A's parent is the child
    const res = await validateParentAssignment({
      db: asDb(db),
      orgId: ORG,
      projectId: PROJECT,
      parentId: PARENT,
      childId: CHILD,
      childTypeId: CHILD_TYPE,
    });
    expect(res).toEqual({
      status: 400,
      error: "That would create a circular parent/child relationship.",
    });
    // Never reached the type check.
    expect(db.workItemType.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an incompatible type pairing (Story under Task)", async () => {
    const db = makeDb();
    db.workItem.findFirst.mockResolvedValue({
      id: PARENT,
      parentId: null,
      workItemType: { key: "software.task", name: "Task" },
    });
    db.workItemType.findUnique.mockResolvedValue({ key: "software.story", name: "Story" });
    const res = await validateParentAssignment({
      db: asDb(db),
      orgId: ORG,
      projectId: PROJECT,
      parentId: PARENT,
      childId: CHILD,
      childTypeId: CHILD_TYPE,
    });
    expect(res).toEqual({ status: 400, error: "A Story can't be nested under a Task." });
  });

  it("accepts a valid nesting (Task under Story)", async () => {
    const db = makeDb();
    db.workItem.findFirst.mockResolvedValue({
      id: PARENT,
      parentId: null,
      workItemType: { key: "software.story", name: "Story" },
    });
    db.workItemType.findUnique.mockResolvedValue({ key: "software.task", name: "Task" });
    const res = await validateParentAssignment({
      db: asDb(db),
      orgId: ORG,
      projectId: PROJECT,
      parentId: PARENT,
      childId: CHILD,
      childTypeId: CHILD_TYPE,
    });
    expect(res).toBeNull();
  });

  it("skips the cycle walk on create (childId null) and accepts a valid type", async () => {
    const db = makeDb();
    db.workItem.findFirst.mockResolvedValue({
      id: PARENT,
      parentId: "A", // has ancestors, but there's no child to collide with yet
      workItemType: { key: "software.story", name: "Story" },
    });
    db.workItemType.findUnique.mockResolvedValue({ key: "software.task", name: "Task" });
    const res = await validateParentAssignment({
      db: asDb(db),
      orgId: ORG,
      projectId: PROJECT,
      parentId: PARENT,
      childId: null,
      childTypeId: CHILD_TYPE,
    });
    expect(res).toBeNull();
    expect(db.workItem.findUnique).not.toHaveBeenCalled(); // no ancestor walk
  });
});
