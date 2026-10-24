// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TransitionPanel } from "./transition-panel";
import type { TransitionSpec } from "@/lib/workflow/definition";

afterEach(() => cleanup());

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const STATUSES = [
  { key: "todo", name: "To Do" },
  { key: "doing", name: "Doing" },
  { key: "done", name: "Done" },
];

const START: TransitionSpec = {
  id: "start",
  name: "Start",
  from: ["todo"],
  to: "doing",
  restrict: { not: { any: [{ kind: "actorIsAssignee" }] } },
  validate: [{ kind: "childrenSettled" }],
  actions: [{ kind: "addComment", body: "Started." }],
};

function setup(t: TransitionSpec = START) {
  const onSave = vi.fn();
  const onDelete = vi.fn();
  render(
    <TransitionPanel transition={t} statuses={STATUSES} customFields={[]} open onOpenChange={() => {}} onSave={onSave} onDelete={onDelete} />,
  );
  return { onSave, onDelete };
}

describe("TransitionPanel", () => {
  it("applies a rename, handing back the id it had", () => {
    const { onSave } = setup();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "  Begin " } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSave).toHaveBeenCalledWith({ ...START, name: "Begin" }, "start");
  });

  it("shows each rule in its tab, with a count", () => {
    setup();
    expect(screen.getByRole("tab", { name: /Restrict/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("The person is an assignee")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Validate/ }));
    expect(screen.getByText("Sub-items are done or cancelled")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Perform actions/ }));
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Started.");
  });

  it("drops a rule removed in its tab, and the restriction once it is empty", () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Remove condition" }));
    fireEvent.click(screen.getByRole("tab", { name: /Validate/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove check" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const saved = onSave.mock.calls[0][0] as TransitionSpec;
    expect(saved.restrict).toBeUndefined();
    expect(saved.validate).toBeUndefined();
    expect(saved.actions).toEqual(START.actions);
  });

  it("keeps a None-of group a None-of group when one of its conditions goes", () => {
    const { onSave } = setup({ ...START, restrict: { not: { any: [{ kind: "actorIsAssignee" }, { kind: "actorIsCreator" }] } } });
    fireEvent.click(screen.getAllByRole("button", { name: "Remove condition" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect((onSave.mock.calls[0][0] as TransitionSpec).restrict).toEqual({ not: { any: [{ kind: "actorIsCreator" }] } });
  });

  it("can't be applied without a name, and deletes by its id", () => {
    const { onDelete } = setup();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete transition" }));
    expect(onDelete).toHaveBeenCalledWith("start");
  });
});
