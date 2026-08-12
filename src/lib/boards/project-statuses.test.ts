import { describe, it, expect } from "vitest";
import { projectStatusColumns } from "./project-statuses";

/**
 * The Status filter took its options from the CURRENT board's own columns, and
 * board creation seeds none — so a Timeline, Roadmap or Calendar board had zero
 * columns and the Status control never rendered. There was no way to filter by
 * status anywhere except the boards that happen to own columns.
 *
 * `work_items.column_key` is a PROJECT-level workflow value, not a board-local
 * one. The options belong to the project, so they are unioned across its boards.
 */

const col = (key: string, name: string, sortOrder: number, category = "TODO") => ({
  key,
  name,
  sortOrder,
  category,
});

describe("projectStatusColumns", () => {
  it("returns a board's columns when the project has one board", () => {
    const boards = [{ columns: [col("todo", "To Do", 0), col("done", "Done", 1)] }];
    expect(projectStatusColumns(boards).map((c) => c.key)).toEqual(["todo", "done"]);
  });

  it("gives a board with NO columns of its own the project's statuses", () => {
    // The reported gap: a Timeline board owns no columns, so Status vanished.
    const boards = [
      { columns: [] },
      { columns: [col("todo", "To Do", 0), col("done", "Done", 1)] },
    ];
    expect(projectStatusColumns(boards).map((c) => c.key)).toEqual(["todo", "done"]);
  });

  it("unions across boards without repeating a shared key", () => {
    const boards = [
      { columns: [col("todo", "To Do", 0), col("doing", "Doing", 1)] },
      { columns: [col("todo", "To Do", 0), col("done", "Done", 2)] },
    ];
    expect(projectStatusColumns(boards).map((c) => c.key)).toEqual([
      "todo",
      "doing",
      "done",
    ]);
  });

  it("orders by workflow position, not by which board was seen first", () => {
    // A filter listing Done before To Do reads as broken even when correct.
    const boards = [
      { columns: [col("done", "Done", 9)] },
      { columns: [col("todo", "To Do", 0), col("doing", "Doing", 5)] },
    ];
    expect(projectStatusColumns(boards).map((c) => c.key)).toEqual([
      "todo",
      "doing",
      "done",
    ]);
  });

  it("keeps the FIRST name seen for a key, so renames on one board do not flap", () => {
    const boards = [
      { columns: [col("todo", "To Do", 0)] },
      { columns: [col("todo", "Backlog", 0)] },
    ];
    expect(projectStatusColumns(boards)[0].name).toBe("To Do");
  });

  it("returns nothing when no board has columns", () => {
    // Then the control correctly stays hidden — there is no workflow to filter.
    expect(projectStatusColumns([{ columns: [] }])).toEqual([]);
    expect(projectStatusColumns([])).toEqual([]);
  });
});
