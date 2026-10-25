// @vitest-environment jsdom
// The confirm step's dialog (schedule-impact-dialog.tsx): generic, so a
// plugin's own schedule page can mount it with its own sections.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { ScheduleImpactDialog } from "./schedule-impact-dialog";

afterEach(cleanup);

const SECTIONS = [
  { key: "schedule", title: "The change", rows: [{ key: "item:a", label: "FSC-1, Design", before: "2 Nov", after: "5 Nov", delta: "3 days later", tone: "neutral" as const }] },
  {
    key: "fees:fee",
    title: "Fee and rate",
    rows: [
      { key: "fee", label: "Fee", after: "Unchanged", tone: "neutral" as const },
      { key: "rate", label: "Effective rate", before: "$100/h", after: "$120/h", tone: "positive" as const },
      { key: "hours", label: "Hours", before: "40 h", after: "52 h", tone: "warn" as const },
    ],
    prompt: { message: "Add 12 h or a person to keep the end date.", action: { label: "Open the phase plan", href: "/acme/plan" } },
  },
];

describe("ScheduleImpactDialog", () => {
  it("shows every section under its heading, rows in order, with before → after", () => {
    render(<ScheduleImpactDialog open sections={SECTIONS} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const fee = screen.getByRole("region", { name: "Fee and rate" });
    expect(within(fee).getAllByRole("listitem").map((li) => li.getAttribute("data-row"))).toEqual(["fee", "rate", "hours"]);
    expect(within(screen.getByRole("region", { name: "The change" })).getByText("3 days later")).toBeTruthy();
    // "to" between the two values for a screen reader; the arrow is decoration.
    expect(within(fee).getAllByText("to")).toHaveLength(2);
  });

  it("tone is said, not only coloured", () => {
    render(<ScheduleImpactDialog open sections={SECTIONS} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("(Better)")).toBeTruthy();
    expect(screen.getByText("(Check)")).toBeTruthy();
  });

  it("a section's prompt and its link are shown", () => {
    render(<ScheduleImpactDialog open sections={SECTIONS} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/Add 12 h or a person/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the phase plan" }).getAttribute("href")).toBe("/acme/plan");
  });

  it("Save confirms, Cancel cancels, and while saving neither can be pressed again", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(<ScheduleImpactDialog open sections={SECTIONS} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(<ScheduleImpactDialog open pending sections={SECTIONS} onConfirm={onConfirm} onCancel={onCancel} />);
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
