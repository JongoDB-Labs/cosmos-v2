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
import {
  projectStatusColumns,
  createStatusOptions,
  editStatusOptions,
  FALLBACK_STATUS_COLUMNS,
} from "./status-columns";

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
    // Honest empty: this reports what the project ACTUALLY defines. Substituting
    // a vocabulary belongs to the picker helpers below, not here.
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

  // COSMOS-168. A Timeline/Gantt board owns no columns, and a project whose
  // boards were all added after creation defines none either — so the picker was
  // empty AND disabled while the dialog still submitted `columnKey: "backlog"`.
  // That is the reported "always defaults to backlog and I can't change it".
  it("offers the fallback workflow when the project defines none either", () => {
    const cols = createStatusOptions([], [{ columns: [] }, {}] as never);
    expect(cols.map((c) => c.key)).toEqual([
      "backlog",
      "todo",
      "in-progress",
      "review",
      "done",
    ]);
  });

  it("starts the fallback on the key creation already writes", () => {
    // The dialog defaults to the FIRST option; landing anywhere but "backlog"
    // would change where items go on projects that have no workflow.
    expect(createStatusOptions([], [] as never)[0].key).toBe("backlog");
  });
});

describe("editStatusOptions", () => {
  it("prefers the project's pooled workflow", () => {
    const cols = editStatusOptions(
      [{ key: "todo", name: "To Do" }],
      [{ key: "risks", name: "Risks" }],
    );
    expect(cols.map((c) => c.key)).toEqual(["todo"]);
  });

  it("falls back to the board's own columns when the pooled list is EMPTY", () => {
    // The regression this fixes: every caller passes an array, so the sheet's
    // old `statusColumns ?? columns` never reached `columns` — not while the
    // boards request was in flight, and not when it failed.
    const cols = editStatusOptions([], [{ key: "todo", name: "To Do" }]);
    expect(cols.map((c) => c.key)).toEqual(["todo"]);
  });

  it("falls back to the board's own columns when no pooled list is passed", () => {
    const cols = editStatusOptions(undefined, [{ key: "todo", name: "To Do" }]);
    expect(cols.map((c) => c.key)).toEqual(["todo"]);
  });

  it("offers the fallback workflow when neither source has anything", () => {
    expect(editStatusOptions([], [])).toBe(FALLBACK_STATUS_COLUMNS);
  });
});
