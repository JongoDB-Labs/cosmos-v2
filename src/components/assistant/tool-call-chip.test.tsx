import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ToolCallChip } from "./tool-call-chip";

afterEach(cleanup);

// A confirm-class call made without its token changes nothing: the loop answers
// with a preview. The chip used to label it like the finished change.
const preview = {
  status: "confirmation_required",
  tool: "delete_work_item",
  change: { itemId: "w1" },
  targetCount: 1,
  targetIds: ["w1"],
};

describe("ToolCallChip", () => {
  it("a preview reads as a proposal, not as the change", () => {
    render(<ToolCallChip tc={{ id: "a", name: "delete_work_item", arguments: { itemId: "w1" }, result: preview }} />);
    const chip = screen.getByTestId("tool-call-chip");
    expect(chip.textContent).toBe("Proposed: delete work item");
    expect(chip.textContent).not.toMatch(/Deleted|Ran /);
    expect(chip.getAttribute("title")).toMatch(/Nothing has changed yet/);
  });

  it("an unlisted tool's preview too", () => {
    render(<ToolCallChip tc={{ name: "delete_board", result: { ...preview, tool: "delete_board" } }} />);
    expect(screen.getByTestId("tool-call-chip").textContent).toBe("Proposed: delete board");
  });

  it("a refusal reads as not done", () => {
    render(<ToolCallChip tc={{ name: "delete_work_item", result: { error: "Work item not found" } }} />);
    expect(screen.getByTestId("tool-call-chip").textContent).toBe("Not done: delete work item");
  });

  it("control: the finished change still reads as done, and a running call as running", () => {
    render(<ToolCallChip tc={{ id: "a", name: "delete_work_item", result: { deleted: true, id: "w1" } }} />);
    render(<ToolCallChip tc={{ id: "b", name: "delete_board", result: { deleted: true } }} />);
    render(<ToolCallChip tc={{ id: "c", name: "list_projects", status: "running", result: null }} />);
    expect(screen.getAllByTestId("tool-call-chip").map((c) => c.textContent)).toEqual([
      "Deleted work item",
      "Ran delete_board",
      "Listing projects…",
    ]);
  });
});
