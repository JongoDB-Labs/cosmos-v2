// @vitest-environment jsdom
//
// The override dialog for the actual start / end a board move stamps.
//
// It exists because moving a card records the date as NOW, which is right only
// when the board is updated the same day the work happened. A user who moved a
// batch of already-underway tickets had every Gantt bar jump to that afternoon
// with no way to correct it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ActualDateDialog, type ActualDateCapture } from "./actual-date-dialog";

afterEach(cleanup);

const capture = (over: Partial<ActualDateCapture> = {}): ActualDateCapture => ({
  itemId: "W1",
  itemTitle: "LI2S Data Pull",
  field: "actualStart",
  capturedIso: "2026-08-14T18:11:39.000Z",
  columnName: "In Progress",
  ...over,
});

describe("ActualDateDialog", () => {
  it("renders nothing when no date was captured", () => {
    const { container } = render(
      <ActualDateDialog capture={null} onClose={() => {}} onConfirm={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("opens seeded with the date the server stamped", () => {
    render(<ActualDateDialog capture={capture()} onClose={() => {}} onConfirm={() => {}} />);
    const input = screen.getByLabelText(/actual start date/i) as HTMLInputElement;
    expect(input.value).toBe("2026-08-14");
  });

  it("names the item and the column, so a batch of prompts stays distinguishable", () => {
    render(<ActualDateDialog capture={capture()} onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText("LI2S Data Pull")).toBeDefined();
    expect(screen.getByText("In Progress")).toBeDefined();
  });

  it("keeping today confirms NOTHING — the stamped date already persisted", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ActualDateDialog capture={capture()} onClose={onClose} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: /keep today/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("submitting the UNCHANGED date also confirms nothing", () => {
    // Guards a pointless write that would show up in the audit trail as a change.
    const onConfirm = vi.fn();
    render(<ActualDateDialog capture={capture()} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a corrected date is sent at MIDDAY UTC, not midnight", () => {
    // Midnight would land on the previous calendar day for any reader behind UTC
    // — the off-by-one this codebase has hit repeatedly.
    const onConfirm = vi.fn();
    render(<ActualDateDialog capture={capture()} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByLabelText(/actual start date/i), {
      target: { value: "2026-07-31" },
    });
    fireEvent.click(screen.getByRole("button", { name: /set start date/i }));
    expect(onConfirm).toHaveBeenCalledWith("W1", "actualStart", "2026-07-31T12:00:00.000Z");
  });

  it("wording follows the field: completion, not start", () => {
    render(
      <ActualDateDialog
        capture={capture({ field: "completedAt", columnName: "Done" })}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText(/when was this finished\?/i)).toBeDefined();
    expect(screen.getByLabelText(/actual completion date/i)).toBeDefined();
  });

  it("a second capture re-seeds from the NEW card, not the previous one", () => {
    // The dialog is keyed on the capture; without that a stale value from the
    // last card would be offered as this card's date.
    const { rerender } = render(
      <ActualDateDialog capture={capture()} onClose={() => {}} onConfirm={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(/actual start date/i), {
      target: { value: "2026-01-01" },
    });
    rerender(
      <ActualDateDialog
        capture={capture({ itemId: "W2", capturedIso: "2026-09-02T10:00:00.000Z" })}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect((screen.getByLabelText(/actual start date/i) as HTMLInputElement).value).toBe(
      "2026-09-02",
    );
  });
});
