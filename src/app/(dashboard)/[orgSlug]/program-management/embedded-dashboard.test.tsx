// The framed outside dashboard. The behaviours pinned here were all found by
// driving the page, not by reading the code:
//
// - The dashboard's own "Sign in" sends the frame to Microsoft, which the CSP
//   refuses, and the frame was left on the browser's broken-page icon. The
//   page hears the refusal (a `securitypolicyviolation` on frame-src). With
//   the click still live it opens the sign-in window itself; without one it
//   swaps the frame for a prompt.
// - Nothing from another site says sign-in finished, so the person coming
//   back to this page finishes it: the window closes and the frame loads
//   AFRESH. "Afresh" means a new iframe element -- re-rendering the same one
//   would keep the stale signed-out page, and would pass a test that only
//   checked an iframe was present.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { EmbeddedDashboard } from "./embedded-dashboard";

const SRC = "https://pm.example.com/";
const SIGN_IN = "https://pm.example.com/auth/start?next=/home";

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

/** jsdom has no navigator.userActivation; the page reads `isActive`. */
function activation(isActive: boolean) {
  Object.defineProperty(navigator, "userActivation", { value: { isActive }, configurable: true });
}

function comeBack() {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

function fakePopup() {
  const popup = { closed: false, close: vi.fn(() => (popup.closed = true)) };
  const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  return { popup, open };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "userActivation");
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

  it("opens the sign-in window itself when the refused frame came from a click", () => {
    activation(true);
    const { open } = fakePopup();
    render(<EmbeddedDashboard src={SRC} signInSrc={SIGN_IN} />);
    violation("frame-src");
    expect(open).toHaveBeenCalledWith(SIGN_IN, expect.any(String), expect.stringContaining("popup"));
    expect(frame()).toBeNull();
    expect(screen.getByText("Signing in…")).toBeTruthy();
  });

  it("control: without a click, it asks instead of opening a window the browser would block", () => {
    activation(false);
    const { open } = fakePopup();
    render(<EmbeddedDashboard src={SRC} signInSrc={SIGN_IN} />);
    violation("frame-src");
    expect(open).not.toHaveBeenCalled();
    expect(frame()).toBeNull();
    expect(screen.getByText("Sign in to see the dashboard")).toBeTruthy();
  });

  it("control: a violation of another directive leaves the frame alone", () => {
    activation(true);
    const { open } = fakePopup();
    render(<EmbeddedDashboard src={SRC} />);
    violation("img-src");
    expect(open).not.toHaveBeenCalled();
    expect(frame()).not.toBeNull();
  });

  it("shows no Sign in over the dashboard, only on the prompt that replaces it", () => {
    // Reported on the live page: a standing "Sign in" beside a signed-in
    // dashboard reads as "you are signed out". This page cannot tell the two
    // apart, so the button lives only on the prompt.
    render(<EmbeddedDashboard src={SRC} />);
    expect(frame()).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();

    // Positive control: the query finds the button when there is one.
    activation(false);
    violation("frame-src");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(frame()).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("the prompt's Sign in opens the dashboard's sign-in start, and the dashboard itself when none is named", () => {
    activation(false);
    const { open } = fakePopup();
    const { unmount } = render(<EmbeddedDashboard src={SRC} signInSrc={SIGN_IN} />);
    violation("frame-src");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(open).toHaveBeenLastCalledWith(SIGN_IN, expect.any(String), expect.any(String));
    expect(screen.getByText("Signing in…")).toBeTruthy();
    unmount();
    render(<EmbeddedDashboard src={SRC} />);
    violation("frame-src");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(open).toHaveBeenLastCalledWith(SRC, expect.any(String), expect.any(String));
  });

  it("coming back to the page closes the sign-in window and loads a NEW frame", () => {
    vi.useFakeTimers();
    activation(true);
    const { popup } = fakePopup();
    render(<EmbeddedDashboard src={SRC} signInSrc={SIGN_IN} />);
    const before = frame();
    violation("frame-src");
    expect(screen.getByText(/Finish signing in in the other window/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    comeBack();
    expect(popup.close).toHaveBeenCalled();
    expect(frame()).not.toBeNull();
    expect(frame()).not.toBe(before);
    expect(screen.queryByText(/Finish signing in in the other window/)).toBeNull();
  });

  it("control: a 'return' in the instant the window opens is ignored", () => {
    vi.useFakeTimers();
    activation(true);
    const { popup } = fakePopup();
    render(<EmbeddedDashboard src={SRC} />);
    violation("frame-src");
    comeBack();
    expect(popup.close).not.toHaveBeenCalled();
    expect(screen.getByText(/Finish signing in in the other window/)).toBeTruthy();
  });

  it("loads a NEW frame once the person closes the sign-in window themselves", () => {
    vi.useFakeTimers();
    activation(true);
    const { popup } = fakePopup();
    render(<EmbeddedDashboard src={SRC} />);
    const before = frame();
    violation("frame-src");

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(frame()).toBeNull();

    popup.closed = true;
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(frame()).not.toBeNull();
    expect(frame()).not.toBe(before);
  });

  it("coming back after the prompt, or from Open in new tab, loads a NEW frame", () => {
    activation(false);
    render(<EmbeddedDashboard src={SRC} />);
    violation("frame-src");
    comeBack();
    const afterPrompt = frame();
    expect(afterPrompt).not.toBeNull();

    fireEvent.click(screen.getByRole("link", { name: /Open in new tab/ }));
    comeBack();
    expect(frame()).not.toBeNull();
    expect(frame()).not.toBe(afterPrompt);
  });

  it("control: coming back with nothing pending leaves the frame as it was", () => {
    render(<EmbeddedDashboard src={SRC} />);
    const before = frame();
    comeBack();
    expect(frame()).toBe(before);
  });

  it("Try again while signing in closes the window and brings the frame back", () => {
    activation(true);
    const { popup } = fakePopup();
    render(<EmbeddedDashboard src={SRC} />);
    violation("frame-src");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(popup.close).toHaveBeenCalled();
    expect(frame()?.getAttribute("src")).toBe(SRC);
  });

  it("a blocked sign-in window leaves the prompt and Open in new tab as the way through", () => {
    activation(true);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<EmbeddedDashboard src={SRC} />);
    violation("frame-src");
    expect(open).toHaveBeenCalled();
    expect(screen.queryByText(/Finish signing in in the other window/)).toBeNull();
    expect(screen.getByText("Sign in to see the dashboard")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    const link = screen.getByRole("link", { name: /Open in new tab/ });
    expect(link.getAttribute("href")).toBe(SRC);
    expect(link.getAttribute("rel")).toContain("noopener");
  });
});
