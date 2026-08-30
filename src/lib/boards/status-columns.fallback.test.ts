// COSMOS-168. The fallback chain that decides which statuses a picker offers,
// for the case the sibling `status-columns.test.ts` suite stops short of: a
// project where NOTHING defines a workflow.
//
// A Timeline/Gantt board owns no BoardColumn rows, and a project whose boards
// were all added after creation (the boards POST route seeds columns only for
// RAID and the two sprint-ceremony types) defines none either. The Status
// control then had nothing in it while the create dialog still submitted
// `columnKey: "backlog"` as ITS own fallback — the reported "always defaults to
// backlog, and I can't change it".
//
// A separate file rather than extra cases in `status-columns.test.ts`: that
// suite is the record of the ORIGINAL board-vs-project fix and is left exactly
// as it shipped.
import { describe, it, expect } from "vitest";
import {
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

describe("createStatusOptions — nothing in the project defines a workflow", () => {
  it("offers the fallback workflow rather than an empty picker", () => {
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
    // would change where items go on a project that has no workflow.
    expect(createStatusOptions([], [] as never)[0].key).toBe("backlog");
  });

  it("does not displace a real workflow when one exists", () => {
    // The fallback is a last resort, not a default — a project that defines
    // statuses must still see exactly those.
    const cols = createStatusOptions([], [kanban] as never);
    expect(cols.map((c) => c.key)).toEqual(["todo", "done"]);
  });
});

describe("editStatusOptions — what the detail sheet offers", () => {
  it("prefers the project's pooled workflow", () => {
    const cols = editStatusOptions(
      [{ key: "todo", name: "To Do" }],
      [{ key: "risks", name: "Risks" }],
    );
    expect(cols.map((c) => c.key)).toEqual(["todo"]);
  });

  it("falls back to the board's own columns when the pooled list is EMPTY", () => {
    // The regression this fixes: every board view passes `useProjectStatuses`,
    // which is an ARRAY — empty while the boards request is in flight and empty
    // again when it fails. The sheet's old `statusColumns ?? columns` fired on
    // neither, so the board's own workflow was never consulted.
    const cols = editStatusOptions([], [{ key: "todo", name: "To Do" }]);
    expect(cols.map((c) => c.key)).toEqual(["todo"]);
  });

  it("falls back to the board's own columns when no pooled list is passed", () => {
    // Kanban and RAID pass no `statusColumns` prop at all; unchanged behaviour.
    const cols = editStatusOptions(undefined, [{ key: "todo", name: "To Do" }]);
    expect(cols.map((c) => c.key)).toEqual(["todo"]);
  });

  it("offers the fallback workflow when neither source has anything", () => {
    expect(editStatusOptions([], [])).toBe(FALLBACK_STATUS_COLUMNS);
  });
});
