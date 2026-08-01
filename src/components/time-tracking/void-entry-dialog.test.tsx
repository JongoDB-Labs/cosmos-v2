// @vitest-environment jsdom
//
// Removing time records a reason. The API has always accepted one; the UI never
// sent it, so every void read as "removed by X at 14:32" with no why — the
// weakest link in an otherwise complete audit chain.
//
// Watch for VACUITY in React tests specifically: re-rendering an identical
// element lets React bail out, so a test can pass against the very bug it
// guards. Every case here drives a real interaction and asserts on what the
// confirm handler RECEIVES, never on what was merely rendered.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VoidEntryDialog } from "./time-tracker";
import type { TimeEntry } from "@/types/models";

const entry = {
  id: "e1",
  date: "2026-07-30",
  hours: 3,
  description: "Radar integration",
  status: "DRAFT",
  billableType: "BILLABLE",
} as unknown as TimeEntry;

function open(onConfirm = vi.fn()) {
  render(
    <VoidEntryDialog entry={entry} onClose={vi.fn()} onConfirm={onConfirm} />,
  );
  return onConfirm;
}

const removeButton = () => screen.getByRole("button", { name: /Remove entry/i });

beforeEach(() => vi.clearAllMocks());

describe("VoidEntryDialog", () => {
  it("cannot be confirmed until a reason is chosen", () => {
    // The whole point. A removal nobody can explain is the gap an audit finds.
    const onConfirm = open();

    expect(removeButton()).toBeDisabled();
    fireEvent.click(removeButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("passes the chosen reason to the caller", () => {
    const onConfirm = open();

    fireEvent.change(screen.getByLabelText(/^Reason$/i), {
      target: { value: "Duplicate entry" },
    });
    fireEvent.click(removeButton());

    expect(onConfirm).toHaveBeenCalledWith("Duplicate entry");
  });

  it("asks for free text when 'something else' is picked, and sends THAT", () => {
    const onConfirm = open();

    fireEvent.change(screen.getByLabelText(/^Reason$/i), {
      target: { value: "__other" },
    });
    const box = screen.getByLabelText(/Reason for removing this entry/i);
    fireEvent.change(box, { target: { value: "Client moved this to next month" } });
    fireEvent.click(removeButton());

    // Not the sentinel — sending "__other" would put a placeholder in the
    // permanent record.
    expect(onConfirm).toHaveBeenCalledWith("Client moved this to next month");
  });

  it("still refuses when 'something else' is picked but left blank", () => {
    const onConfirm = open();

    fireEvent.change(screen.getByLabelText(/^Reason$/i), {
      target: { value: "__other" },
    });

    expect(removeButton()).toBeDisabled();
    fireEvent.click(removeButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("treats whitespace as no reason at all", () => {
    const onConfirm = open();

    fireEvent.change(screen.getByLabelText(/^Reason$/i), {
      target: { value: "__other" },
    });
    fireEvent.change(screen.getByLabelText(/Reason for removing this entry/i), {
      target: { value: "   " },
    });

    expect(removeButton()).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("says the entry is KEPT, not erased", () => {
    // The wording is load-bearing: "delete" promises an erasure that must not
    // happen, and a worker who believes it will not expect the row to survive
    // in the record with their name on it.
    open();
    expect(screen.getByText(/kept in the record/i)).toBeInTheDocument();
  });

  it("renders nothing when no entry is being removed", () => {
    render(
      <VoidEntryDialog entry={null} onClose={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.queryByText(/Remove this time entry\?/i)).toBeNull();
  });
});
