// @vitest-environment jsdom
//
// A resize drag must stop when it ends — by ANY route.
//
// The first version removed its listeners only on `pointerup`, so a drag that
// finished another way (pointercancel from an OS/trackpad gesture, the window
// losing focus, pointer capture lost) left `pointermove` live on `window`
// forever. It also never checked whether a button was still held, so from then
// on the drawer tracked the BARE pointer — its edge following the mouse with
// nothing pressed. Each later drag stacked another live listener, and each move
// also wrote to localStorage synchronously.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/lib/hooks/use-media-query", () => ({ useMediaQuery: () => true }));

const setWidth = vi.fn();
vi.mock("./drawer-provider", () => ({
  useDrawers: () => ({
    tool: "assistant",
    seed: null,
    open: vi.fn(),
    openDrawer: vi.fn(),
    toggle: vi.fn(),
    close: vi.fn(),
    isOpen: (t: string) => t === "assistant",
    width: 460,
    setWidth,
  }),
  DRAWER_MIN_WIDTH: 320,
  DRAWER_MAX_WIDTH: 900,
}));
vi.mock("@/components/assistant/assistant-panel", () => ({ AssistantPanel: () => null }));
vi.mock("./panels/chat-panel", () => ({ ChatPanel: () => null }));
vi.mock("./panels/notes-panel", () => ({ NotesPanel: () => null }));
vi.mock("./panels/feedback-panel", () => ({ FeedbackPanel: () => null }));
vi.mock("./panels/meetings-panel", () => ({ MeetingsPanel: () => null }));

import { DockedDrawer } from "./docked-drawer";

/** A pointer event jsdom will carry: MouseEvent has `buttons` and `clientX`. */
const move = (clientX: number, buttons = 1) =>
  window.dispatchEvent(new MouseEvent("pointermove", { clientX, buttons, bubbles: true }));

function startDrag() {
  render(<DockedDrawer orgId="o1" orgSlug="acme" userId="u1" />);
  const handle = screen.getByRole("separator", { name: "Resize drawer" });
  fireEvent.pointerDown(handle, { pointerId: 1, buttons: 1, clientX: 500 });
  return handle;
}

beforeEach(() => setWidth.mockReset());
afterEach(cleanup);

describe("DockedDrawer — resize drag", () => {
  it("resizes while the pointer is down", () => {
    // Positive control for every "stops" case below: without it they would all
    // pass against a handler that never resized at all.
    startDrag();
    move(900);
    expect(setWidth).toHaveBeenCalledTimes(1);
  });

  it("stops on pointerup", () => {
    startDrag();
    move(900);
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    setWidth.mockReset();
    move(800);
    expect(setWidth).not.toHaveBeenCalled();
  });

  it("stops on pointercancel — an OS or trackpad gesture taking over", () => {
    startDrag();
    window.dispatchEvent(new MouseEvent("pointercancel", { bubbles: true }));
    move(800);
    expect(setWidth).not.toHaveBeenCalled();
  });

  it("stops when the window loses focus mid-drag", () => {
    startDrag();
    window.dispatchEvent(new Event("blur"));
    move(800);
    expect(setWidth).not.toHaveBeenCalled();
  });

  it("stops when pointer capture is lost", () => {
    startDrag();
    window.dispatchEvent(new Event("lostpointercapture"));
    move(800);
    expect(setWidth).not.toHaveBeenCalled();
  });

  it("stops on the next move if the release was missed entirely", () => {
    // The backstop. No pointerup, no cancel, no blur — just a move with no
    // button held, which is exactly what a bare mouse looks like.
    startDrag();
    move(800, 0);
    expect(setWidth).not.toHaveBeenCalled();
    move(700, 1); // and it stays stopped
    expect(setWidth).not.toHaveBeenCalled();
  });

  it("does not stack listeners across drags", () => {
    // Each drag used to add another live pointermove handler, so N lost drags
    // meant N setWidth calls per mouse move.
    const handle = startDrag();
    window.dispatchEvent(new MouseEvent("pointercancel", { bubbles: true }));
    fireEvent.pointerDown(handle, { pointerId: 2, buttons: 1, clientX: 500 });
    setWidth.mockReset();
    move(900);
    expect(setWidth).toHaveBeenCalledTimes(1);
  });
});
