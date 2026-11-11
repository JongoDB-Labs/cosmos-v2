// The framed outside dashboard. Two behaviours are worth pinning, because
// both were found by driving the page, not by reading the code:
//
// - The dashboard's own "Sign in" sends the frame to Microsoft, which the CSP
//   refuses, and the frame was left on the browser's broken-page icon. The
//   page now hears the refusal (a `securitypolicyviolation` on frame-src) and
//   swaps the frame for a prompt.
// - Sign-in happens in a window of its own; when it closes, the frame must
//   load AFRESH to pick up the new session. "Afresh" means a new iframe
//   element -- re-rendering the same one would keep the stale signed-out page,
//   and would pass a test that only checked an iframe was present.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { EmbeddedDashboard } from "./embedded-dashboard";

const SRC = "https://pm.example.com/";

function frame(): HTMLIFrameElement | null {
  return document.querySelector('iframe[title="Program management dashboard"]');
}

function violation(directive: string) {
  // jsdom has no SecurityPolicyViolationEvent; the handler reads one field.
  const e = new Event("securitypolicyviolation");
  Object.defineProperty(e, "effectiveDirective", { value: directive });
  act(() => {
    document.dispatchEvent(e);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EmbeddedDashboard", () => {
  it("frames the configured URL, without letting it navigate the whole tab", () => {
    render(<EmbeddedDashboard src={SRC} />);
    const f = frame();
    expect(f?.getAttribute("src")).toBe(SRC);
    const sandbox = f?.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-top-navigation");
  });

  it("replaces the frame with a sign-in prompt when the frame is refused somewhere", () => {
    render(<EmbeddedDashboard src={SRC} />);
    violation("frame-src");
    expect(frame()).toBeNull();
    expect(screen.getByText("Sign in to see the dashboard")).toBeTruthy();
  });

  it("control: a violation of another directive leaves the frame alone", () => {
    render(<EmbeddedDashboard src={SRC} />);
    violation("img-src");
    expect(frame()).not.toBeNull();
    expect(screen.queryByText("Sign in to see the dashboard")).toBeNull();
  });

  it("Try again brings the frame back", () => {
    render(<EmbeddedDashboard src={SRC} />);
    violation("frame-src");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(frame()?.getAttribute("src")).toBe(SRC);
  });

  it("loads a NEW frame once the sign-in window closes", () => {
    vi.useFakeTimers();
    const popup = { closed: false };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    render(<EmbeddedDashboard src={SRC} />);
    const before = frame();

    fireEvent.click(screen.getAllByRole("button", { name: "Sign in" })[0]);
    expect(open).toHaveBeenCalledWith(SRC, expect.any(String), expect.stringContaining("popup"));
    expect(screen.getByText(/Finish signing in in the other window/)).toBeTruthy();

    // Still open: nothing reloads yet.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(frame()).toBe(before);

    popup.closed = true;
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(frame()).not.toBeNull();
    expect(frame()).not.toBe(before);
    expect(screen.queryByText(/Finish signing in in the other window/)).toBeNull();
  });

  it("a blocked sign-in window changes nothing, leaving Open in new tab as the way through", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<EmbeddedDashboard src={SRC} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Sign in" })[0]);
    expect(screen.queryByText(/Finish signing in in the other window/)).toBeNull();
    const link = screen.getByRole("link", { name: /Open in new tab/ });
    expect(link.getAttribute("href")).toBe(SRC);
    expect(link.getAttribute("rel")).toContain("noopener");
  });
});
