// COSMOS-88: right-click a board to create the item class appropriate for it.
// The context menu's default type + label and the target-column resolution are
// the pure seams behind that flow — tested here without driving the base-ui
// menu/dialog (which needs jsdom pointer polyfills the setup doesn't ship).
import { describe, it, expect } from "vitest";
import {
  defaultBoardTypeId,
  createActionLabel,
  resolveTargetColumnKey,
  type CreateTypeOption,
} from "./board-create";
import type { BoardColumn } from "@/types/models";

const types: CreateTypeOption[] = [
  { id: "t-story", key: "software.story", name: "Story" },
  { id: "t-task", key: "software.task", name: "Task" },
  { id: "t-bug", key: "software.bug", name: "Bug" },
];

const columns = [
  { key: "todo", sortOrder: 0 },
  { key: "doing", sortOrder: 1 },
  { key: "done", sortOrder: 2 },
] as BoardColumn[];

describe("defaultBoardTypeId", () => {
  it("prefers the sector-prefixed task type", () => {
    expect(defaultBoardTypeId(types)).toBe("t-task");
  });

  it("prefers a bare `task` custom type too", () => {
    expect(
      defaultBoardTypeId([{ id: "x", key: "task", name: "Task" }]),
    ).toBe("x");
  });

  it("falls back to the first type when there is no task type", () => {
    expect(
      defaultBoardTypeId([
        { id: "t-risk", key: "risk", name: "Risk" },
        { id: "t-issue", key: "issue", name: "Issue" },
      ]),
    ).toBe("t-risk");
  });

  it("returns '' while the types are still loading/empty", () => {
    expect(defaultBoardTypeId([])).toBe("");
  });
});

describe("createActionLabel", () => {
  it("labels the action with the appropriate default type", () => {
    expect(createActionLabel(types)).toBe("New task");
  });

  it("falls back to a generic label before the types load", () => {
    expect(createActionLabel([])).toBe("New issue");
  });
});

describe("resolveTargetColumnKey", () => {
  it("pre-scopes to a right-clicked column when it exists", () => {
    expect(resolveTargetColumnKey(columns, "doing")).toBe("doing");
  });

  it("falls back to the first column for an empty-background right-click", () => {
    expect(resolveTargetColumnKey(columns, null)).toBe("todo");
  });

  it("ignores a preferred key that isn't on the board", () => {
    expect(resolveTargetColumnKey(columns, "ghost")).toBe("todo");
  });

  it("returns '' when the board has no columns", () => {
    expect(resolveTargetColumnKey([], "todo")).toBe("");
  });
});
