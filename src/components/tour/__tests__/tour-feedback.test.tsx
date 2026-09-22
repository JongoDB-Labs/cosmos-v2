// Feedback raised from a walkthrough has to be findable as a SET later. The
// tour and step used to live only in the description prose — readable, but not
// something a queue can be filtered by, which is the question that matters once
// a release is reviewed through the walkthrough itself.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TourFeedback } from "../tour-feedback";
import type { TourStep } from "@/lib/tours/types";

const step: TourStep = { id: "runway", title: "Runway", blurb: "b", look: "l" };

let sent: Record<string, unknown>;
beforeEach(() => {
  vi.restoreAllMocks();
  sent = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }),
  );
});

async function submit(text = "the runway column confused me") {
  render(<TourFeedback orgId="o1" step={step} tourName="Phase health" tourId="phase-health-2026-09" />);
  fireEvent.change(screen.getByLabelText(/Feedback about Runway/i), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
  await waitFor(() => expect(sent.title).toBeDefined());
}

describe("provenance travels with the feedback", () => {
  it("marks it as raised from a walkthrough", async () => {
    await submit();
    expect(sent.source).toBe("tour");
  });

  it("points at the STEP, not just the release", async () => {
    await submit();
    expect(sent.sourceRef).toBe("phase-health-2026-09/runway");
  });

  it("keeps saying so in the description, so the item still reads alone", async () => {
    // The structured field is for filtering; wherever an item is shown without
    // it — an export, an email, a work-item body — the sentence still explains
    // where it came from.
    await submit();
    expect(String(sent.description)).toContain("phase-health-2026-09/runway");
    expect(String(sent.description)).toContain("Phase health");
  });

  it("carries the person's own words as the title", async () => {
    await submit("the runway column confused me");
    expect(sent.title).toBe("the runway column confused me");
  });
});
