// Reported from the Timeline / Gantt: the "New issue" dialog opened with Status
// empty and disabled, and "Create issue" permanently greyed out — the button was
// there but could never be pressed. Submitting requires a columnKey, and the
// dialog only ever offered THIS board's columns. Timeline, Calendar, RAID and
// Roadmap boards are all seeded with `columns: []`, so on any of them the dialog
// was a dead end.
//
// Moved here from create-issue-button.test.tsx when the board-local create
// dialog was retired in favour of the full one every board now shares.
import { describe, it, expect } from "vitest";
import { projectStatusColumns, createStatusOptions } from "./status-columns";

const kanban = {
  columns: [
    { key: "todo", name: "To Do", sortOrder: 0 },
    { key: "done", name: "Done", sortOrder: 2 },
  ],
};
const backlog = {
  columns: [
    { key: "backlog", name: "Backlog", sortOrder: 1 },
    { key: "todo", name: "To Do", sortOrder: 0 },
  ],
};

describe("projectStatusColumns", () => {
  it("gathers the project's statuses from whichever boards define them", () => {
    const cols = projectStatusColumns([{ columns: [] }, kanban, backlog] as never);
    expect(cols.map((c) => c.key)).toEqual(["todo", "backlog", "done"]);
  });

  it("dedupes a status shared by several boards", () => {
    const cols = projectStatusColumns([kanban, backlog] as never);
    expect(cols.filter((c) => c.key === "todo")).toHaveLength(1);
  });

  it("returns nothing when no board in the project defines a workflow", () => {
    // Honest empty rather than a fabricated status — the dialog stays disabled,
    // which is correct when the project genuinely has nowhere to put an item.
    expect(projectStatusColumns([{ columns: [] }, {}] as never)).toEqual([]);
  });
});

describe("createStatusOptions", () => {
  it("prefers the board's own workflow", () => {
    // Creating from the Kanban should offer the Kanban's statuses, not a pooled
    // set that includes columns belonging to some other board.
    const cols = createStatusOptions(kanban.columns as never, [kanban, backlog] as never);
    expect(cols.map((c) => c.key)).toEqual(["todo", "done"]);
  });

  it("falls back to the project when the board defines no columns", () => {
    // The Timeline/Calendar/RAID/Roadmap case: `columns: []` must borrow rather
    // than leave the picker empty and the dialog unsubmittable.
    const cols = createStatusOptions([], [kanban, backlog] as never);
    expect(cols.map((c) => c.key)).toEqual(["todo", "backlog", "done"]);
  });

  it("falls back when the board is unknown entirely", () => {
    // `boardId` that matches nothing (deleted board, stale link) resolves to
    // undefined columns — still must not strand the user.
    const cols = createStatusOptions(undefined, [kanban] as never);
    expect(cols.map((c) => c.key)).toEqual(["todo", "done"]);
  });

  it("sorts a board's own columns by sortOrder", () => {
    const cols = createStatusOptions(backlog.columns as never, [] as never);
    expect(cols.map((c) => c.key)).toEqual(["todo", "backlog"]);
  });
});
