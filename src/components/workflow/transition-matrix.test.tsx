// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TransitionMatrix } from "./transition-matrix";
import type { WorkflowDefinition } from "@/lib/workflow/definition";

afterEach(() => cleanup());

const STATUSES = [
  { key: "todo", name: "To Do", color: "#888" },
  { key: "doing", name: "Doing", color: "#00f" },
  { key: "done", name: "Done", color: "#0f0" },
];
const DEF: WorkflowDefinition = {
  schemaVersion: 1,
  statuses: [{ key: "todo", isInitial: true }, { key: "doing" }, { key: "done" }],
  transitions: [
    { id: "start", name: "Start", from: ["todo"], to: "doing", restrict: { kind: "actorIsAssignee" } },
    { id: "done", name: "Done", from: "*", to: "done" },
  ],
};

function setup(readOnly = false) {
  const onChange = vi.fn();
  const onEdit = vi.fn();
  render(<TransitionMatrix definition={DEF} statuses={STATUSES} onChange={onChange} onEditTransition={onEdit} readOnly={readOnly} />);
  return { onChange, onEdit };
}

describe("TransitionMatrix", () => {
  it("ticks each allowed move, by a named transition or one from any status", () => {
    setup();
    expect(screen.getByRole("checkbox", { name: "Move from To Do to Doing" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Move from Doing to Done" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Allow a move into Done from any status" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Move from Doing to To Do" })).not.toBeChecked();
    // No checkbox for a move onto the same status.
    expect(screen.queryByRole("checkbox", { name: "Move from Doing to Doing" })).toBeNull();
  });

  it("adds a move named after its status when a cell is ticked", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Move from Doing to To Do" }));
    const next = onChange.mock.calls[0][0] as WorkflowDefinition;
    expect(next.transitions.at(-1)).toEqual({ id: "doing-to-todo", name: "To Do", from: ["doing"], to: "todo" });
  });

  it("keeps the other sources of a move from any status when one cell is unticked", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Move from Doing to Done" }));
    const next = onChange.mock.calls[0][0] as WorkflowDefinition;
    expect(next.transitions.find((t) => t.id === "done")?.from).toEqual(["todo"]);
  });

  it("opens a transition with rules from its cell", () => {
    const { onEdit } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit transition Start" }));
    expect(onEdit).toHaveBeenCalledWith("start");
    // A move from any status is edited from its own row.
    fireEvent.click(screen.getByRole("button", { name: "Edit transition Done" }));
    expect(onEdit).toHaveBeenLastCalledWith("done");
  });

  it("is a table a screen reader can walk, and changes nothing read-only", () => {
    const { onChange } = setup(true);
    expect(screen.getByRole("table", { name: /Allowed moves/ })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: /Any status/ })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["From \\ To", "To Do", "Doing", "Done"]);
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
