import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { LocalTimestamp } from "./local-timestamp";
import { formatDateTimeStable } from "@/lib/format/stable-date";

// An instant where UTC and a US zone disagree on BOTH the hour and the calendar
// day — 2026-07-30T02:15:00Z is 10:15 PM on Jul 29 in New York.
const INSTANT = "2026-07-30T02:15:00.000Z";

describe("LocalTimestamp", () => {
  it("server-renders the UTC-pinned string, so the HTML cannot depend on the server's zone", () => {
    // renderToString is the closest we get to the real SSR pass in a unit test.
    const html = renderToString(<LocalTimestamp value={INSTANT} />);
    expect(html).toContain(formatDateTimeStable(INSTANT));
    expect(html).toContain("Jul 30, 2026");
  });

  it("the client's FIRST render matches the server exactly", () => {
    // This is the property that prevents React #418: both sides see mounted=false.
    const server = renderToString(<LocalTimestamp value={INSTANT} />);
    expect(server).toContain("Jul 30, 2026");
  });

  it("shows the reader's zone after mount", () => {
    // Testing Library flushes effects, so this is the post-mount render.
    render(<LocalTimestamp value={INSTANT} />);
    const expected = new Date(INSTANT).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    expect(screen.getByText(expected)).toBeDefined();
  });

  it("renders the fallback for a missing timestamp, and never a bare dash by accident", () => {
    render(<LocalTimestamp value={null} />);
    expect(screen.getByText("—")).toBeDefined();
  });

  it("renders the fallback for an unparseable value rather than 'Invalid Date'", () => {
    const html = renderToString(<LocalTimestamp value="not-a-date" fallback="never" />);
    expect(html).toContain("never");
    expect(html).not.toContain("Invalid");
  });

  it("honours a custom fallback", () => {
    render(<LocalTimestamp value={undefined} fallback="never" />);
    expect(screen.getByText("never")).toBeDefined();
  });
});
