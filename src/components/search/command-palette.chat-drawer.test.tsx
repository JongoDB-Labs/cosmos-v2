// @vitest-environment jsdom
// COSMOS-32 — chat must open in the docked slide drawer, NOT navigate to the
// orphaned standalone /chat page. The topbar, mobile bottom-nav and mobile
// sidebar already call openDrawer("chat"); the command palette (⌘K — the
// keyboard-shortcut entry point) still did router.push("/<org>/chat"), which
// is the reported regression. This locks the ⌘K entry point to the drawer.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// --- base-ui / cmdk need these in jsdom (see memory: testing-base-ui-in-jsdom) ---
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!Element.prototype[m]) {
    // @ts-expect-error — no-op pointer-capture stubs for jsdom
    Element.prototype[m] = () => {};
  }
}

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/acme",
}));

import { CommandPalette } from "./command-palette";
import { DrawerProvider, useDrawers } from "@/components/drawers/drawer-provider";

// Surfaces the currently-open docked drawer tool so the test can assert the
// palette opened the chat drawer in place (rather than navigating away).
function DrawerProbe() {
  const { tool } = useDrawers();
  return <div data-testid="drawer-tool">{tool ?? "none"}</div>;
}

function renderPalette() {
  return render(
    <DrawerProvider>
      <DrawerProbe />
      <CommandPalette orgs={[{ id: "org-1", slug: "acme" }]} />
    </DrawerProvider>,
  );
}

afterEach(() => {
  cleanup();
  push.mockClear();
});

describe("CommandPalette — Chat opens the docked drawer (COSMOS-32)", () => {
  it("opens the Chat drawer in place (never the orphaned /chat page) when selected via ⌘K", async () => {
    const user = userEvent.setup();
    renderPalette();

    // Drawer starts closed.
    expect(screen.getByTestId("drawer-tool")).toHaveTextContent("none");

    // Open the palette via the keyboard shortcut (⌘K) — the entry point that
    // was navigating to the old page.
    fireEvent.keyDown(document, { key: "k", metaKey: true });

    // The "Go to" list surfaces Chat; select it.
    const chat = await screen.findByText("Chat");
    await user.click(chat);

    // The docked drawer switches to the chat tool…
    await waitFor(() =>
      expect(screen.getByTestId("drawer-tool")).toHaveTextContent("chat"),
    );
    // …and nothing navigated to a standalone page.
    expect(push).not.toHaveBeenCalled();
  });
});
