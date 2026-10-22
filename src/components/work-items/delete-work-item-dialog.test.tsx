// @vitest-environment jsdom
//
// COSMOS-201: one "Delete work item?" dialog for every surface. The wording,
// the disabled-while-deleting state and Cancel used to be copied three times.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DeleteWorkItemDialog } from "./delete-work-item-dialog";

afterEach(cleanup);

function renderDialog(props: Partial<Parameters<typeof DeleteWorkItemDialog>[0]> = {}) {
  const handlers = { onCancel: vi.fn(), onConfirm: vi.fn() };
  render(
    <DeleteWorkItemDialog open pending={false} ticketLabel="FSC-7" title="Rewire the telemetry" {...handlers} {...props} />,
  );
  return handlers;
}

describe("DeleteWorkItemDialog", () => {
  it("names the item it will delete", () => {
    renderDialog();
    expect(screen.getByText("Delete work item?")).toBeTruthy();
    expect(screen.getByText(/permanently delete FSC-7 "Rewire the telemetry"/)).toBeTruthy();
  });

  it("confirms and cancels", () => {
    const h = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.onConfirm).toHaveBeenCalledOnce();
    expect(h.onCancel).toHaveBeenCalledOnce();
  });

  it("locks both buttons while the delete is in flight", () => {
    renderDialog({ pending: true });
    expect((screen.getByRole("button", { name: "Deleting…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
