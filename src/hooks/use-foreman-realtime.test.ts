// @vitest-environment jsdom
//
// COSMOS-127 — the Foreman console subscribes to the org realtime stream so an
// Approve / Rework / Rebuild (which lands the ticket in its next column) and any
// feedback intake decision refresh the console the instant they publish, rather
// than waiting on the (now slow, backstop-only) status poll. This locks the
// subscribe+apply wiring: the hook registers handlers for every foreman-relevant
// event type and fans each one out to `onChange`.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// Capture the handler map the hook hands to useRealtimeEvents (which itself opens
// an SSE EventSource jsdom lacks) so we can drive events synchronously.
let captured: Record<string, (data: unknown) => void> = {};
vi.mock("./use-realtime-events", () => ({
  useRealtimeEvents: (_orgId: string, handlers: Record<string, (data: unknown) => void>) => {
    captured = handlers;
  },
}));

import { useForemanRealtime } from "./use-foreman-realtime";

beforeEach(() => {
  captured = {};
});

describe("useForemanRealtime", () => {
  it("subscribes to every work-item and feedback event the console reacts to", () => {
    renderHook(() => useForemanRealtime("org-1", () => {}));

    expect(Object.keys(captured)).toEqual(
      expect.arrayContaining([
        "work-item.created",
        "work-item.updated",
        "work-item.deleted",
        "feedback.throttled",
        "feedback.gated",
        "feedback.flagged",
        "feedback.duplicate",
        "feedback.delivered",
      ]),
    );
  });

  it("fires onChange for a board move (work-item.updated) and a feedback decision", () => {
    const onChange = vi.fn();
    renderHook(() => useForemanRealtime("org-1", onChange));

    // A daemon-driven column move (Approve → next column) publishes this.
    captured["work-item.updated"]({ projectId: "p1", columnKey: "review" });
    // A feedback intake decision publishes this.
    captured["feedback.delivered"]({ feedbackId: "f1" });

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("reads onChange fresh on every event, so a re-render's latest closure wins", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useForemanRealtime("org-1", cb), {
      initialProps: { cb: first },
    });

    rerender({ cb: second });
    captured["work-item.created"]({ projectId: "p1" });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
