// The walkthrough's answers must read exactly like the assistant's.
//
// They were rendered as plain text, so a list arrived as literal hyphens, bold
// as asterisks, and a table as a wall of pipes — the model formats its answers
// whether or not the surface is ready for it.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TourAsk } from "../tour-ask";
import type { TourStep } from "@/lib/tours/types";

const step: TourStep = {
  id: "s1",
  title: "Runway",
  blurb: "b",
  look: "l",
  asks: ["How is runway calculated?"],
};

/** One SSE frame per delta, the shape the assistant stream emits. */
function streamOf(chunks: string[]) {
  const body = chunks.map((c) => `data: ${JSON.stringify({ delta: c })}\n`).join("");
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).endsWith("/conversations")) {
        return { ok: true, json: async () => ({ data: { id: "c1" } }) } as unknown as Response;
      }
      return streamOf([
        "Runway is **hours left** divided by pace.\n\n",
        "- trailing four weeks\n- clipped to the phase\n",
      ]) as unknown as Response;
    }),
  );
});

describe("answers render as rich text", () => {
  it("renders markdown rather than printing its syntax", async () => {
    render(<TourAsk orgId="o1" step={step} tourName="Phase health" />);
    fireEvent.click(screen.getByText("How is runway calculated?"));

    await waitFor(() => expect(screen.getByText("hours left")).toBeInTheDocument());
    // Bold became an element, not asterisks around a word.
    expect(screen.getByText("hours left").tagName).toBe("STRONG");
    // The bullets became a real list.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    // And none of the raw syntax survived into the text.
    expect(document.body.textContent).not.toContain("**");
  });

  it("streams deltas into one growing answer rather than repeating them", async () => {
    render(<TourAsk orgId="o1" step={step} tourName="Phase health" />);
    fireEvent.click(screen.getByText("How is runway calculated?"));
    await waitFor(() => expect(screen.getByText("hours left")).toBeInTheDocument());
    const text = document.body.textContent ?? "";
    // "Runway is" appears once: concatenating whole-message frames instead of
    // deltas would show it twice.
    expect(text.split("Runway is").length - 1).toBe(1);
  });
});

describe("when the assistant cannot answer", () => {
  it("says so instead of leaving an empty box", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/conversations")
          ? ({ ok: true, json: async () => ({ data: { id: "c1" } }) } as unknown as Response)
          : (streamOf([]) as unknown as Response),
      ),
    );
    render(<TourAsk orgId="o1" step={step} tourName="Phase health" />);
    fireEvent.click(screen.getByText("How is runway calculated?"));
    await waitFor(() =>
      expect(screen.getByText(/no answer came back/i)).toBeInTheDocument(),
    );
  });
});
