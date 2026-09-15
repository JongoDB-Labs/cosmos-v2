// The cell that lets an approver decide what an entry bills.
//
// Two things must hold: the control appears only where the action would actually
// succeed, and a deliberate zero survives the round trip. Offering a control that
// always 400s is worse than not offering it, and a zero that silently becomes
// "bill as logged" is an invoice nobody meant to send.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { TimeEntry } from "@/types/models";

const { can } = vi.hoisted(() => ({ can: vi.fn() }));
vi.mock("@/components/providers/permissions-provider", () => ({
  usePermissions: () => ({ can }),
  Permission: { TIME_BILL: 1n << 120n },
}));

import { BilledHoursCell } from "./billed-hours-cell";

const entry = (over: Partial<TimeEntry> = {}): TimeEntry =>
  ({
    id: "e1",
    orgId: "o1",
    userId: "u1",
    projectId: null,
    workItemId: null,
    clinId: null,
    date: "2026-03-02",
    hours: 6,
    rate: null,
    client: null,
    description: "",
    billableType: "BILLABLE",
    status: "APPROVED",
    approvedById: "m1",
    approvedAt: "2026-03-03T00:00:00.000Z",
    billedHours: null,
    billedById: null,
    billedAt: null,
    tags: [],
    createdAt: "",
    updatedAt: "",
    ...over,
  }) as TimeEntry;

beforeEach(() => {
  vi.clearAllMocks();
  can.mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("what it shows", () => {
  it("says 'as logged' rather than repeating the number", () => {
    // Two identical figures side by side make the reader work out whether they
    // were supposed to differ.
    render(<BilledHoursCell entry={entry()} orgId="o1" onSaved={vi.fn()} />);
    expect(screen.getByText(/as logged/i)).toBeInTheDocument();
  });

  it("shows the decided figure and the gap when one was taken", () => {
    render(<BilledHoursCell entry={entry({ billedHours: 2 })} orgId="o1" onSaved={vi.fn()} />);
    expect(screen.getByText("2.00")).toBeInTheDocument();
    expect(screen.getByText("(-4.00)")).toBeInTheDocument();
  });

  it("shows a write-up with its sign", () => {
    render(<BilledHoursCell entry={entry({ billedHours: 8 })} orgId="o1" onSaved={vi.fn()} />);
    expect(screen.getByText("(+2.00)")).toBeInTheDocument();
  });
});

describe("who may act", () => {
  it("offers no control without TIME_BILL", () => {
    can.mockReturnValue(false);
    render(<BilledHoursCell entry={entry()} orgId="o1" onSaved={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers no control on an entry that is not approved", () => {
    // The route refuses these. A control that always fails is worse than none.
    render(<BilledHoursCell entry={entry({ status: "SUBMITTED" })} orgId="o1" onSaved={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the control to an approver on an approved entry", () => {
    render(<BilledHoursCell entry={entry()} orgId="o1" onSaved={vi.fn()} />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});

describe("saving", () => {
  it("sends an explicit zero, not null", async () => {
    // "Worked, not billed" must reach the server as 0. Sending null would record
    // "no decision" and bill the full logged hours.
    const onSaved = vi.fn();
    render(<BilledHoursCell entry={entry()} orgId="o1" onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByLabelText("Billed hours"), { target: { value: "0" } });
    fireEvent.click(screen.getByLabelText("Save billed hours"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: "e1", billedHours: 0 }));
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toEqual({ billedHours: 0 });
  });

  it("clears the decision when the field is emptied", async () => {
    const onSaved = vi.fn();
    render(<BilledHoursCell entry={entry({ billedHours: 2 })} orgId="o1" onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByLabelText("Billed hours"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Save billed hours"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: "e1", billedHours: null }));
  });

  it("saves on Enter too, with the same zero handling", async () => {
    // The keyboard path is separate code from the Save button and was the half a
    // mutation run reached first -- worth its own test rather than trusting the
    // two branches to stay in step.
    const onSaved = vi.fn();
    render(<BilledHoursCell entry={entry()} orgId="o1" onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByLabelText("Billed hours");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: "e1", billedHours: 0 }));
  });

  it("clears on Enter when emptied", async () => {
    const onSaved = vi.fn();
    render(<BilledHoursCell entry={entry({ billedHours: 2 })} orgId="o1" onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByLabelText("Billed hours");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: "e1", billedHours: null }));
  });

  it("surfaces the server's refusal instead of claiming success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Only approved entries can be billed" }) }),
    );
    const onSaved = vi.fn();
    render(<BilledHoursCell entry={entry()} orgId="o1" onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByLabelText("Save billed hours"));
    await waitFor(() => expect(screen.getByText(/only approved/i)).toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled();
  });
});
