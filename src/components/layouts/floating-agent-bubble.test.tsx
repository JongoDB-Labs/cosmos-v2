// @vitest-environment jsdom
//
// The corner button sits in ONE place. It used to move itself out of the way
// of whatever was under it (re-picked on every scroll, resize and DOM change),
// so its position depended on the page. Now the page keeps room for it instead
// (the published --cosmos-launcher-clear), and its attached control puts the
// assistant aside to the side tab.
//
// jsdom cannot hit-test, so "never moves" is guarded end to end in
// e2e/assistant-panel-layering.spec.ts; this pins the mechanics.
import { useEffect } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

vi.mock("@/lib/hooks/use-media-query", () => ({ useMediaQuery: () => true }));
vi.mock("@/components/providers/permissions-provider", () => ({
  usePermissions: () => ({ can: () => true }),
}));
vi.mock("@/components/assistant/assistant-panel", () => ({ AssistantPanel: () => null }));
vi.mock("@/components/drawers/panels/chat-panel", () => ({ ChatPanel: () => null }));
vi.mock("@/components/drawers/panels/notes-panel", () => ({ NotesPanel: () => null }));
vi.mock("@/components/drawers/panels/feedback-panel", () => ({ FeedbackPanel: () => null }));
vi.mock("@/components/drawers/panels/meetings-panel", () => ({ MeetingsPanel: () => null }));

import { DrawerProvider, useDrawers, type DrawerTool } from "@/components/drawers/drawer-provider";
import { DockedDrawer } from "@/components/drawers/docked-drawer";
import { FloatingAgentBubble } from "./floating-agent-bubble";

let api: ReturnType<typeof useDrawers>;
function Grab() {
  const d = useDrawers();
  useEffect(() => {
    api = d;
  });
  return null;
}
const clear = () => document.documentElement.style.getPropertyValue("--cosmos-launcher-clear");
const clearMobile = () =>
  document.documentElement.style.getPropertyValue("--cosmos-launcher-clear-mobile");
const launcher = () => screen.queryByRole("button", { name: /^Open / });

function mount({ drawer = false } = {}) {
  return render(
    <DrawerProvider>
      <Grab />
      <FloatingAgentBubble orgId="org-1" />
      {drawer && <DockedDrawer orgId="org-1" orgSlug="acme" userId="u1" />}
    </DrawerProvider>,
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe("FloatingAgentBubble", () => {
  it("no longer dodges: no dodge module, no observers or scroll listeners", () => {
    const src = readFileSync(join(process.cwd(), "src/components/layouts/floating-agent-bubble.tsx"), "utf8");
    expect(src).not.toMatch(/bubble-dodge|MutationObserver|ResizeObserver|addEventListener\("scroll"/);
    const mo = vi.spyOn(window, "MutationObserver");
    const add = vi.spyOn(window, "addEventListener");
    mount();
    expect(mo).not.toHaveBeenCalled();
    expect(add.mock.calls.map((c) => c[0])).not.toContain("scroll");
    mo.mockRestore();
    add.mockRestore();
  });

  it.each(["assistant", "chat", "notes"] as DrawerTool[])(
    "is hidden while %s is open or minimized",
    (tool) => {
      mount();
      expect(launcher()).not.toBeNull();
      act(() => api.open(tool));
      expect(launcher()).toBeNull();
      act(() => api.minimize());
      expect(launcher()).toBeNull();
      act(() => api.close());
      expect(launcher()).not.toBeNull();
    },
  );

  it("its minimize control minimizes without opening", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /to the side$/ }));
    expect(api.tool).toBe("assistant");
    expect(api.minimized).toBe(true);
  });

  it("publishes the bottom clearance only while shown", () => {
    const { unmount } = mount();
    expect(clear()).toBe("88px");
    expect(clearMobile()).toContain("5.25rem");
    act(() => api.open("assistant"));
    expect(clear()).toBe("0px");
    expect(clearMobile()).toBe("0px");
    act(() => api.close());
    expect(clear()).toBe("88px");
    unmount();
    expect(clear()).toBe("0px");
  });

  it("cosmos:agent:open still opens the assistant while the button is unmounted", () => {
    mount({ drawer: true });
    act(() => api.minimize());
    expect(launcher()).toBeNull();
    act(() => {
      window.dispatchEvent(new Event("cosmos:agent:open"));
    });
    expect(api.tool).toBe("assistant");
    expect(api.minimized).toBe(false);
  });
});
