// @vitest-environment jsdom
//
// The way out of a blocked submission: ask somebody to supervise you.
//
// Watch for VACUITY in React tests specifically: re-rendering an identical
// element lets React bail out, so a test can pass against the very bug it
// guards. Every case here drives a real interaction and asserts on what the
// submit handler RECEIVES, never on what was merely rendered.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RequestSupervisorDialog } from "./time-tracker";

const CANDIDATES = [
  { employeeId: "emp-bob", displayName: "Bob" },
  { employeeId: "emp-carol", displayName: "Carol" },
];

function open(
  over: Partial<React.ComponentProps<typeof RequestSupervisorDialog>> = {},
) {
  const onSubmit = vi.fn();
  render(
    <RequestSupervisorDialog
      open
      candidates={CANDIDATES}
      pending={false}
      onClose={vi.fn()}
      onSubmit={onSubmit}
      {...over}
    />,
  );
  return onSubmit;
}

const sendButton = () => screen.getByRole("button", { name: /Send request/i });

beforeEach(() => vi.clearAllMocks());

describe("RequestSupervisorDialog", () => {
  it("sends the employee id of the person actually ticked", () => {
    // The id, not the name — the endpoint works in employee ids, and sending a
    // user id would be silently refused as ineligible.
    const onSubmit = open();
    fireEvent.click(screen.getByLabelText("Carol"));
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledWith(["emp-carol"]);
  });

  it("supports asking SEVERAL people at once", () => {
    // Both real cases are plural: a matrixed org, or hedging against one person
    // being on leave. Asking one at a time would mean one blocked week per ask.
    const onSubmit = open();
    fireEvent.click(screen.getByLabelText("Bob"));
    fireEvent.click(screen.getByLabelText("Carol"));
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledWith(["emp-bob", "emp-carol"]);
  });

  it("un-ticking removes them from the request", () => {
    // Guards the toggle: an add-only handler would send somebody the worker
    // deliberately deselected.
    const onSubmit = open();
    fireEvent.click(screen.getByLabelText("Bob"));
    fireEvent.click(screen.getByLabelText("Carol"));
    fireEvent.click(screen.getByLabelText("Bob"));
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledWith(["emp-carol"]);
  });

  it("cannot send an EMPTY request", () => {
    // A request naming nobody notifies nobody and leaves the worker still
    // blocked, having been told it worked.
    open();
    expect(sendButton()).toBeDisabled();
  });

  it("cannot be sent twice while one is in flight", () => {
    open({ pending: true });
    fireEvent.click(screen.getByLabelText("Bob"));
    expect(sendButton()).toBeDisabled();
  });

  it("explains itself when there is nobody to ask", () => {
    // Should be unreachable — the server exempts you from the block entirely
    // when nobody could supervise you — but a modal that opens empty and says
    // nothing is the worst version of this screen. It also names the REAL fix,
    // which is granting somebody the role, not adding a supervisor.
    open({ candidates: [] });
    expect(screen.getByText(/Reviewer \/ Approver/i)).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it("says the approver makes the assignment, not the worker", () => {
    // The segregation of duties is the whole reason this is a request rather
    // than a picker, and the worker should understand what they just did.
    open();
    expect(screen.getByText(/they make the assignment/i)).toBeInTheDocument();
  });
});
