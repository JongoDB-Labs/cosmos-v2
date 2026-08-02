// @vitest-environment jsdom
//
// The queue of weeks waiting on YOU.
//
// Routing has notified approvers since 2.255.0, but the notification was the
// only way to reach a week — read once, then gone. This is the standing answer
// to "what do I owe?".
//
// Watch for VACUITY in React tests: re-rendering an identical element lets
// React bail out, so a test can pass against the very bug it guards. The cases
// below drive real interactions and assert on what the handler RECEIVES.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  ApprovalsQueue,
  orderQueue,
  queueLabel,
  type QueuedSheet,
} from "./approvals-queue";

const sheet = (over: Partial<QueuedSheet> = {}): QueuedSheet => ({
  id: "ts-1",
  userId: "u-alice",
  periodStart: "2026-07-27",
  periodEnd: "2026-08-02",
  status: "SUBMITTED",
  workerName: "Alice",
  ...over,
});

function mockQueue(data: QueuedSheet[] | { fail: true }) {
  const fetchMock = vi.fn().mockImplementation(() =>
    "fail" in (data as object)
      ? Promise.reject(new Error("network"))
      : Promise.resolve({ ok: true, json: async () => ({ data }) }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.clearAllMocks());

describe("orderQueue", () => {
  it("puts the LONGEST-waiting week first", () => {
    // A queue that buries the oldest week under this morning's submission grows
    // a tail nobody ever reaches.
    const out = orderQueue([
      sheet({ id: "new", periodStart: "2026-07-27" }),
      sheet({ id: "old", periodStart: "2026-06-01" }),
      sheet({ id: "mid", periodStart: "2026-07-06" }),
    ]);
    expect(out.map((s) => s.id)).toEqual(["old", "mid", "new"]);
  });

  it("does not mutate the array it was given", () => {
    // The caller holds this array in state; sorting in place would reorder
    // React's data behind its back.
    const input = [
      sheet({ id: "b", periodStart: "2026-07-27" }),
      sheet({ id: "a", periodStart: "2026-06-01" }),
    ];
    orderQueue(input);
    expect(input.map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("queueLabel", () => {
  it("is singular for one", () => {
    // "1 weeks waiting" reads as a bug and undermines the rest of the screen.
    expect(queueLabel(1)).toBe("1 week waiting on you");
  });

  it("is plural for more", () => {
    expect(queueLabel(3)).toBe("3 weeks waiting on you");
  });
});

describe("ApprovalsQueue", () => {
  it("renders NOTHING once the server says nothing is waiting", async () => {
    // A permanently present "0 waiting" panel is the fastest way to teach
    // someone to stop looking at it.
    //
    // DRIVEN AS A TRANSITION, and it has to be. Asserting "the container is
    // empty" on a fresh mount passes before the fetch has even resolved — it
    // measures the loading state, not the answer, and mutation testing caught
    // it doing exactly that. Watching the panel DISAPPEAR proves the empty
    // response was actually processed.
    let payload: QueuedSheet[] = [sheet()];
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, json: async () => ({ data: payload }) }),
      ),
    );
    const { container, rerender } = render(
      <ApprovalsQueue orgId="o1" refreshKey={0} onOpen={vi.fn()} />,
    );
    await screen.findByText("Alice");

    payload = [];
    rerender(<ApprovalsQueue orgId="o1" refreshKey={1} onOpen={vi.fn()} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renders nothing once a request FAILS", async () => {
    // The queue is an accelerator, not the only route to a week — the person
    // picker still works. A failure must not put an error box on everyone's
    // time-tracking page. Same transition shape, for the same reason.
    let fail = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        fail
          ? Promise.reject(new Error("network"))
          : Promise.resolve({ ok: true, json: async () => ({ data: [sheet()] }) }),
      ),
    );
    const { container, rerender } = render(
      <ApprovalsQueue orgId="o1" refreshKey={0} onOpen={vi.fn()} />,
    );
    await screen.findByText("Alice");

    fail = true;
    rerender(<ApprovalsQueue orgId="o1" refreshKey={1} onOpen={vi.fn()} />);

    // The PREVIOUS rows stay — a failed refresh must not blank a queue the
    // approver was reading. What matters is that no error box appears.
    await waitFor(() =>
      expect(screen.queryByText(/error|failed/i)).not.toBeInTheDocument(),
    );
    expect(container).not.toBeEmptyDOMElement();
  });

  it("names the worker whose week it is", async () => {
    mockQueue([sheet()]);
    render(<ApprovalsQueue orgId="o1" refreshKey={0} onOpen={vi.fn()} />);
    expect(await screen.findByText("Alice")).toBeInTheDocument();
  });

  it("opens the week that was CLICKED, not the first one", async () => {
    // The off-by-one that would send an approver to the wrong person's week.
    const onOpen = vi.fn();
    mockQueue([
      sheet({ id: "a", userId: "u-alice", periodStart: "2026-06-01", workerName: "Alice" }),
      sheet({ id: "b", userId: "u-bob", periodStart: "2026-07-06", workerName: "Bob" }),
    ]);
    render(<ApprovalsQueue orgId="o1" refreshKey={0} onOpen={onOpen} />);

    const bobsButton = await screen.findByRole("button", { name: /Open Bob/i });
    fireEvent.click(bobsButton);

    expect(onOpen).toHaveBeenCalledWith("u-bob", "2026-07-06");
  });

  it("asks the server for MY queue, not every timesheet", async () => {
    // Without awaitingMe this lists every readable sheet, which for an admin is
    // the whole org — the opposite of a queue.
    const fetchMock = mockQueue([sheet()]);
    render(<ApprovalsQueue orgId="o1" refreshKey={0} onOpen={vi.fn()} />);
    await screen.findByText("Alice");
    expect(fetchMock.mock.calls[0][0]).toContain("awaitingMe=1");
  });

  it("marks a week that has passed labor approval", async () => {
    // Otherwise an approver hunts for an Approve button already pressed.
    mockQueue([sheet({ status: "LABOR_APPROVED" })]);
    render(<ApprovalsQueue orgId="o1" refreshKey={0} onOpen={vi.fn()} />);
    expect(await screen.findByText(/Awaiting cost/i)).toBeInTheDocument();
  });

  it("refetches when the parent says something changed", async () => {
    // After an approval the week is no longer waiting; a stale queue would
    // invite approving it twice.
    const fetchMock = mockQueue([sheet()]);
    const { rerender } = render(
      <ApprovalsQueue orgId="o1" refreshKey={0} onOpen={vi.fn()} />,
    );
    await screen.findByText("Alice");

    rerender(<ApprovalsQueue orgId="o1" refreshKey={1} onOpen={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
