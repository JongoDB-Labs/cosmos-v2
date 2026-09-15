// @vitest-environment jsdom
//
// COSMOS-132 — the project boards (kanban / backlog / org-wide Issues) subscribe
// to the org realtime stream so a work-item create / update / delete refreshes
// the view the instant it publishes. Foreman drives these events cross-process
// (COSMOS-127/-358: the daemon NOTIFYs `work-item.updated` on every autonomous
// column move), so this hook is the client end of "prove foreman realtime emits
// reach the boards." This locks the subscribe+filter wiring: the hook registers
// handlers for every work-item event type and, when scoped to a project, fans
// out ONLY that project's events to `onChange` (a null scope reacts to all).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// Capture the handler map the hook hands to useRealtimeEvents (which itself opens
// an SSE EventSource jsdom lacks) so we can drive events synchronously.
let captured: Record<string, (data: unknown) => void> = {};
let capturedOptions: { onResync?: () => void } | undefined;
vi.mock("./use-realtime-events", () => ({
  useRealtimeEvents: (
    _orgId: string,
    handlers: Record<string, (data: unknown) => void>,
    options?: { onResync?: () => void },
  ) => {
    captured = handlers;
    capturedOptions = options;
  },
}));

import { useWorkItemRealtime } from "./use-work-item-realtime";

beforeEach(() => {
  captured = {};
  capturedOptions = undefined;
});

describe("useWorkItemRealtime", () => {
  it("subscribes to every work-item event a board reacts to", () => {
    renderHook(() => useWorkItemRealtime("org-1", null, () => {}));

    expect(Object.keys(captured)).toEqual(
      expect.arrayContaining(["work-item.created", "work-item.updated", "work-item.deleted"]),
    );
  });

  it("org-wide scope (projectId null) fires onChange for every project's event", () => {
    const onChange = vi.fn();
    renderHook(() => useWorkItemRealtime("org-1", null, onChange));

    captured["work-item.updated"]({ projectId: "p1", columnKey: "review" });
    captured["work-item.created"]({ projectId: "p2" });
    // A payload without a projectId (e.g. deletes) still counts org-wide.
    captured["work-item.deleted"]({});

    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("project scope fires only for its OWN project's events", () => {
    const onChange = vi.fn();
    renderHook(() => useWorkItemRealtime("org-1", "p1", onChange));

    // A daemon-driven column move in the watched project (Foreman → next column).
    captured["work-item.updated"]({ projectId: "p1", columnKey: "in-progress" });
    // The same event in a DIFFERENT project must not refresh this board.
    captured["work-item.updated"]({ projectId: "p2", columnKey: "in-progress" });
    // A payload missing projectId can't match a scoped board, so it's ignored.
    captured["work-item.created"]({});

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reads onChange fresh on every event, so a re-render's latest closure wins", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useWorkItemRealtime("org-1", "p1", cb), {
      initialProps: { cb: first },
    });

    rerender({ cb: second });
    captured["work-item.updated"]({ projectId: "p1" });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("recovering the events the stream cannot replay", () => {
  it("refetches when the connection comes back", () => {
    // The stream has no replay, so a reconnect means "things may have changed
    // while we were away". A deploy drops every open tab at once, and before
    // this the board simply stayed stale until someone hit refresh.
    const onChange = vi.fn();
    renderHook(() => useWorkItemRealtime("org-1", null, onChange));

    capturedOptions?.onResync?.();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("refetches on reconnect even when scoped to ONE project", () => {
    // The payload filter cannot apply here: the whole problem is that we never
    // saw the payloads. Skipping the refetch for a scoped board would leave
    // exactly the views Foreman drives showing stale columns.
    const onChange = vi.fn();
    renderHook(() => useWorkItemRealtime("org-1", "p1", onChange));

    capturedOptions?.onResync?.();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("actually passes an onResync — the control for the two tests above", () => {
    // Both assertions use optional chaining, so a hook that passed no options
    // at all would satisfy them vacuously by calling nothing.
    renderHook(() => useWorkItemRealtime("org-1", null, () => {}));
    expect(typeof capturedOptions?.onResync).toBe("function");
  });
});
